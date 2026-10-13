/**
 * Which Tally is this machine holding — the real books, or a copy?
 *
 * ── The problem this exists for ───────────────────────────────────────────
 *
 * TWO MACHINES SHARE ONE SUPABASE MIRROR, and they cannot be told apart.
 *
 * The real books run on the owner's other computer and sync from there. This
 * repo is also run on a development machine against a DUPLICATE company — and a
 * Tally duplicate carries the SAME NAME as the original. Every mirror table is
 * keyed on that name alone, so both machines write the same rows.
 *
 * Two things follow, and both are damaging:
 *
 *   · A scheduled sync on the dev machine mirrors the SANDBOX over the real
 *     company's vouchers. The dashboard would then serve a copy's data as
 *     current, with nothing anywhere saying so.
 *   · The push agent on the dev machine would claim jobs from the shared
 *     `push_queue` and book real business vouchers into the SANDBOX — where
 *     they are lost, while the queue row reads "succeeded".
 *
 * Neither announces itself. The second is worse: an invoice someone raised on
 * the web app would simply never appear in the real books.
 *
 * ── The declaration ───────────────────────────────────────────────────────
 *
 *   MKCP_TALLY_ROLE=primary   this machine holds the real books (the default,
 *                             so existing installations behave exactly as before)
 *   MKCP_TALLY_ROLE=sandbox   this machine holds a copy — it must not write to
 *                             anything shared
 *
 * Defaulting to `primary` is deliberate. The alternative — defaulting to safe —
 * would silently stop the real machine from syncing the moment this shipped,
 * which is a worse failure than the one being prevented and much harder to
 * notice. A copy is the unusual case and is the one that declares itself.
 */

export type TallyRole = "primary" | "sandbox";

export function tallyRole(): TallyRole {
  return (process.env.MKCP_TALLY_ROLE ?? "").trim().toLowerCase() === "sandbox"
    ? "sandbox"
    : "primary";
}

export const isSandbox = (): boolean => tallyRole() === "sandbox";

/**
 * Refuse a shared write from a sandbox machine, and say why.
 *
 * Returns true when the caller should STOP. Logs once per call site rather than
 * silently returning, because a sync that quietly does nothing is the failure
 * mode this whole codebase keeps producing.
 */
export function refuseSharedWrite(what: string): boolean {
  if (!isSandbox()) return false;
  console.warn(
    `🛑 [sandbox] ${what} refused — MKCP_TALLY_ROLE=sandbox.\n` +
    `   This machine holds a COPY of the company, and the Supabase mirror is\n` +
    `   keyed on the company name, which the copy shares with the real books.\n` +
    `   Writing from here would overwrite real data with a copy's.`,
  );
  return true;
}

/** One line at startup, so which machine this is never has to be guessed. */
export function announceRole(): void {
  if (isSandbox()) {
    console.log("🛑 [sandbox] MKCP_TALLY_ROLE=sandbox — scheduled syncs and push-queue draining are OFF.");
  } else {
    console.log("📒 [primary] MKCP_TALLY_ROLE=primary — this machine writes to the shared Supabase mirror.");
  }
}

/**
 * #128 — on this laptop, only the practice company may receive a request.
 *
 * Enforced when the machine is a sandbox, or when MKCP_PRACTICE_COMPANY is
 * set. The practice company is named by that env var. A request that names a
 * different company is refused; so is a company-scoped request when no practice
 * company is declared. A request naming no company is refused too, because
 * Tally would run it against whatever company is open, except the company
 * listing, which is how the practice company is discovered in the first place.
 *
 * Returns the refusal text, or null when the request may go. Pure: no I/O.
 */
export function companyRefusal(xml: string): string | null {
  const practice = (process.env.MKCP_PRACTICE_COMPANY ?? "").trim();
  if (!isSandbox() && practice === "") return null;
  const m = /<SVCURRENTCOMPANY>([\s\S]*?)<\/SVCURRENTCOMPANY>/i.exec(xml);
  if (!m) {
    if (/<ID>\s*List of Companies\s*<\/ID>/i.test(xml)) return null;
    return "refused: this request names no company, so Tally would use whichever company is open. This machine accepts only the practice company.";
  }
  const named = decodeEntities(m[1]).trim();
  if (practiceGuid() === "") return "refused: MKCP_PRACTICE_COMPANY_GUID is not set, so this machine cannot prove which company it holds. Nothing was sent to Tally.";
  if (practice !== "" && named.toLowerCase() === practice.toLowerCase()) return null;
  return `refused: company "${named}" is not the practice company${practice ? "" : " (MKCP_PRACTICE_COMPANY is not set)"}. Nothing was sent to Tally.`;
}

/** The company a request names, or null when it names none (listing, health). */
export function companyNamed(xml: string): string | null {
  const m = /<SVCURRENTCOMPANY>([\s\S]*?)<\/SVCURRENTCOMPANY>/i.exec(xml);
  return m ? decodeEntities(m[1]).trim() : null;
}

/** The GUID the practice company must carry. Env, never code: a GUID is an identity. */
export function practiceGuid(): string {
  return (process.env.MKCP_PRACTICE_COMPANY_GUID ?? "").trim();
}

/**
 * #128 — a name is shared by the practice copy and the real books, so the GUID
 * decides. Pure: reads the company listing Tally returns and maps each company
 * name to the GUID loaded under it. A company with no GUID is left out.
 */
export function companyGuidsFromListing(xml: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of xml.matchAll(/<COMPANY\b([^>]*)>([\s\S]*?)<\/COMPANY>/gi)) {
    const attr = /NAME="([^"]*)"/i.exec(m[1])?.[1];
    const el = /<NAME[^>]*>([\s\S]*?)<\/NAME>/i.exec(m[2])?.[1];
    const guid = /<GUID[^>]*>([\s\S]*?)<\/GUID>/i.exec(m[2])?.[1]?.trim();
    const name = decodeEntities(attr ?? el ?? "").trim();
    if (name && guid) out.set(name, guid);
  }
  return out;
}

/** Named, decimal and hex entities, decoded in one pass so "&amp;quot;" stays "&quot;". */
export function decodeEntities(s: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, e: string) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
    }
    return named[e.toLowerCase()] ?? whole;
  });
}

/** True when the GUID check applies: the same condition that enables companyRefusal. */
export function guidCheckRequired(): boolean {
  return isSandbox() || (process.env.MKCP_PRACTICE_COMPANY ?? "").trim() !== "";
}
