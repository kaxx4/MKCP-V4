/**
 * The next FREE voucher number, when the one we asked for was taken.
 *
 * ── Why this exists, and why the obvious cure was wrong ───────────────────
 *
 * Pushing a Payment whose number Tally already holds comes back
 * `created=0 errors=0 exceptions=1` with no reason given. Reproduced against a
 * real company on 17-Sep-2026, four pushes in a row:
 *
 *   fresh number            created=1  exceptions=0
 *   the SAME number again   created=0  exceptions=1   ← the operator's bug
 *   the number OMITTED      created=0  exceptions=1   ← the "obvious" cure
 *   the NEXT free number    created=1  exceptions=0   ← the real one
 *
 * The third line is the one that matters. Payment, Receipt, Contra and Sales
 * are all configured "Automatic (Manual Override)" in this company — which
 * says Tally numbers them itself — and it does NOT do so for a voucher arriving
 * over XML. Auto-numbering is a behaviour of interactive entry. A recovery that
 * dropped the number would have traded one silent failure for another, and it
 * was committed before this was measured.
 *
 * ── Why the number cannot simply be incremented ───────────────────────────
 *
 * The counter is not always at the end. In these books:
 *
 *   Payment    1838/26-27        counter FIRST
 *   Receipt     612/26-27        first
 *   Sales     26-27/0678         LAST, zero-padded to four
 *   Debit Note  CRN/1460         last
 *
 * Add one to the trailing digits of `1838/26-27` and you get `1838/26-28` — a
 * voucher filed into next financial year. So the counter is LEARNED from the
 * numbers Tally itself holds for that type, never assumed, and when it cannot
 * be learned the answer is null and the original error stands.
 *
 * This mirrors `engine/voucher/voucherNumbering.ts` in the web app, which
 * learns the same pattern from the Supabase mirror. They are deliberately not
 * one module — different processes, different corpora, no shared package — so
 * the rule is: both learn, neither assumes, and each states its source. The
 * web app's copy answers "what should this voucher be numbered"; this one
 * answers the narrower "that number was taken, what is free", against Tally's
 * own list rather than a mirror that may be behind.
 */

/** "26-27/0678" → ["26","-","27","/","0678"] */
function tokenise(s: string): string[] {
  return s.match(/\d+|\D+/g) ?? [];
}

/** "26-27/0678" → '["#","-","#","/","#"]'. Same layout AND same fixed text. */
function layout(tokens: string[]): string {
  return JSON.stringify(tokens.map((t) => (/^\d+$/.test(t) ? "#" : t)));
}

/**
 * A number of the same shape as `failed` that nothing in `taken` uses.
 *
 * Returns null when the counter cannot be identified — which is a real answer.
 * Guessing here means filing a voucher into the wrong year or the wrong series,
 * and a refused push the operator can see is better than a booked voucher
 * nobody will look at again.
 */
export function nextFreeNumber(taken: readonly string[], failed: string): string | null {
  const failedTokens = tokenise(String(failed ?? "").trim());
  if (!failedTokens.length) return null;

  const shape = layout(failedTokens);
  const set = new Set(taken.map((t) => String(t ?? "").trim()).filter(Boolean));
  const peers = [...set].map(tokenise).filter((t) => layout(t) === shape);

  const digitAt = failedTokens
    .map((t, i) => (/^\d+$/.test(t) ? i : -1))
    .filter((i) => i >= 0);
  if (!digitAt.length) return null;

  let counterIndex: number;
  if (digitAt.length === 1) {
    // Only one digit run: it is the counter, peers or not.
    counterIndex = digitAt[0];
  } else {
    /* Several digit runs, so the counter has to be identified rather than
       picked. It is the one that MOVES across the type's real numbers: a year
       suffix repeats on every voucher, a serial does not. Where more than one
       moves, the widest spread wins — a year differs by one across a rollover,
       a serial spans hundreds. */
    if (peers.length < 2) return null;
    const moving = digitAt
      .map((i) => {
        const vals = peers.map((p) => parseInt(p[i], 10)).filter(Number.isFinite);
        return { i, spread: vals.length ? Math.max(...vals) - Math.min(...vals) : 0 };
      })
      .filter((c) => c.spread > 0)
      .sort((a, b) => b.spread - a.spread);
    if (!moving.length) return null;
    counterIndex = moving[0].i;
  }

  const width = failedTokens[counterIndex].length;
  const build = (n: number): string =>
    failedTokens
      .map((t, i) => (i === counterIndex ? String(n).padStart(width, "0") : t))
      .join("");

  /* Start ABOVE the highest the type already holds in this shape, not merely
     above the one that failed. The mirror can be several vouchers behind — that
     staleness is the whole reason the number collided — so `failed + 1` would
     often collide again and burn the single retry for nothing. */
  const peerMax = peers.reduce((m, p) => {
    const v = parseInt(p[counterIndex], 10);
    return Number.isFinite(v) && v > m ? v : m;
  }, parseInt(failedTokens[counterIndex], 10) || 0);

  /* Then walk up until the string itself is free. Bounded: an unbounded loop
     against a corrupt list would hang the agent, and the push queue's whole
     purpose is that a stuck job is visible rather than silent. */
  for (let n = peerMax + 1; n <= peerMax + 1000; n++) {
    const candidate = build(n);
    if (!set.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Every voucher number Tally holds for one type.
 *
 * Measured on the live company: Payment returns 891 numbers in about 1 MB and
 * six seconds. Far too slow to run before every push — and it never does. This
 * is a RECOVERY path, reached only after a voucher has already been refused,
 * where six seconds is cheaper than a lost payment.
 *
 * Asked for by type through a FILTER rather than pulled and filtered here: a
 * full voucher collection is 229 MB and wedges Tally. Only the number and the
 * type come back; entry blocks are ~64x the payload and nothing here needs them.
 *
 * On any failure this returns an EMPTY list rather than throwing, and an empty
 * list makes `nextFreeNumber` refuse to guess for a multi-run number — so a
 * failed lookup degrades into "report the original error", never into a number
 * invented from nothing.
 */
export async function takenNumbers(
  tallyUrl: string,
  company: string,
  voucherType: string,
  post: (url: string, xml: string, timeoutMs: number, raw: boolean) => Promise<unknown> = defaultPost,
): Promise<string[]> {
  const esc = (v: string) =>
    v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>MkNums</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="MkNums" ISMODIFY="No"><TYPE>Voucher</TYPE>
<NATIVEMETHOD>VoucherNumber</NATIVEMETHOD><NATIVEMETHOD>VoucherTypeName</NATIVEMETHOD>
<FILTER>MkNumsF</FILTER></COLLECTION>
<SYSTEM TYPE="Formulae" NAME="MkNumsF">$VoucherTypeName = "${esc(voucherType)}"</SYSTEM>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
  try {
    const res = (await post(tallyUrl, xml, 180_000, true)) as string;
    return [...res.matchAll(/<VOUCHERNUMBER>([^<]*)<\/VOUCHERNUMBER>/gi)]
      .map((m) => m[1].trim())
      .filter(Boolean);
  } catch (e) {
    console.warn(`[numbering] could not list ${voucherType} numbers: ${(e as Error).message}`);
    return [];
  }
}

/* Imported lazily so this module stays pure for its tests — they must not need
   a Tally to run, and they do not. */
async function defaultPost(url: string, xml: string, timeoutMs: number, raw: boolean): Promise<unknown> {
  const { tallyPost } = await import("../tally.js");
  return tallyPost(url, xml, timeoutMs, raw);
}
