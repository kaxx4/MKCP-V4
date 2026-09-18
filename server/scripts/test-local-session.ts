/**
 * A full dummy session, driven the way a front end would drive it.
 *
 * Over HTTP against the running agent — not by calling the services directly —
 * because the point is to prove the ROUTES work, and a harness that reaches
 * past them proves only the internals it reached for. Every dead feature in
 * these repos had working internals.
 *
 * ── What it proves ────────────────────────────────────────────────────────
 *
 *   the machine says it is offline        no Supabase, by configuration
 *   masters come back                     the pickers a front end needs
 *   a voucher is CREATED                  guarded, pushed, read back
 *   it appears in the day's list          the read half agrees with the write
 *   it is ALTERED                         narration changes in the books
 *   it is CANCELLED                       keeps its number, stops being a posting
 *   it is DELETED                         gone, day count back where it started
 *
 * That is the whole loop the owner asked for: pull from Tally, push to Tally,
 * edit, all on this computer with Supabase switched off.
 *
 * ── Safe by construction ──────────────────────────────────────────────────
 *
 * The agent refuses every shared write when MKCP_TALLY_ROLE=sandbox, which this
 * script asserts BEFORE it pushes anything. If that assertion fails it stops —
 * running a dummy session against a machine that can reach the real mirror is
 * the one thing worth refusing to do.
 *
 *   node dist/index.js        # in another terminal
 *   npx tsx scripts/test-local-session.ts [--keep]
 */
const BASE = process.env.MKCP_AGENT_URL || "http://localhost:3100";
const KEEP = process.argv.includes("--keep");

const DATE = new Date().toISOString().slice(0, 10);
const TAG = `LS${Date.now().toString().slice(-5)}`;

let passed = 0, failed = 0;
const failures: string[] = [];
const ok = (label: string, cond: boolean, detail = "") => {
  if (cond) { passed++; console.log(`    \x1b[32m✓\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`); }
  else { failed++; failures.push(label); console.log(`    \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`); }
};
const H = (s: string) => console.log(`\n\x1b[1m── ${s} ${"─".repeat(Math.max(0, 56 - s.length))}\x1b[0m`);

async function get(path: string): Promise<any> {
  const r = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(180_000) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function post(path: string, body: unknown): Promise<any> {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

(async () => {
  console.log(`\n\x1b[1mA full dummy session over the agent's own API\x1b[0m\n`);
  console.log(`agent   ${BASE}`);

  H("THE MACHINE SAYS WHAT IT IS");
  const status = await get("/api/local/status");
  if (status.status !== 200) {
    console.error(`\n  The agent is not answering on ${BASE}. Start it with \`node dist/index.js\`.\n`);
    process.exit(1);
  }
  console.log(`company ${status.body.company}`);
  ok("Tally is reachable and a company is open", Boolean(status.body.company));
  /* Refuse to run a dummy session on a machine that could reach the real
     mirror. This is the assertion that makes the rest of the script safe. */
  ok("this machine is OFFLINE — nothing here can reach Supabase",
    status.body.offline === true, status.body.offlineReason ?? "ONLINE");
  if (status.body.offline !== true) {
    console.error(`\n  Refusing to push: this machine is not offline.\n`);
    process.exit(1);
  }
  ok("and declares itself a sandbox", status.body.role === "sandbox", status.body.role);

  H("MASTERS — WHAT A FRONT END NEEDS TO OFFER");
  const masters = await get("/api/local/masters");
  ok("masters come back", masters.status === 200 && masters.body?.ok === true);
  const ledgers: { name: string; parent: string; state?: string }[] = masters.body?.ledgers ?? [];
  ok("ledgers are listed", ledgers.length > 0, `${ledgers.length}`);
  ok("items are listed", (masters.body?.items ?? []).length > 0, `${masters.body?.items?.length ?? 0}`);

  /* "Bank Charges" matches /BANK/ and is an expense, not an account. Pick from
     the BANK ACCOUNTS group, which is what the other side of a payment is. */
  const bank = ledgers.find((l) => /BANK ACCOUNTS/i.test(l.parent ?? ""))?.name
    ?? ledgers.find((l) => /^HDFC/i.test(l.name))?.name;
  const party = ledgers.find((l) => /SUNDRY DEBTORS/i.test(l.parent) && l.state)?.name;
  ok("a bank and a party ledger can be picked", Boolean(bank && party), `${party} / ${bank}`);
  if (!bank || !party) process.exit(1);

  const number = `${TAG}/S`;
  const remoteId = `MKCP|Payment|${number}|2026-27`;
  const payload = {
    remoteId, voucherType: "Payment", date: DATE, voucherNumber: number,
    narration: "local session harness — safe to remove",
    partyLedgerName: party, isInvoice: false,
    ledgerEntries: [
      { ledgerName: party, amount: 100, isDeemedPositive: true, isPartyLedger: true },
      { ledgerName: bank, amount: 100, isDeemedPositive: false, isPartyLedger: false },
    ],
  };

  const day = async () => (await get(`/api/local/vouchers?date=${DATE}`)).body;
  const before = await day();
  const startCount = before?.count ?? 0;
  let pushed = false;

  try {
    H("CREATE");
    pushed = true;
    const created = await post("/api/local/push", { payload });
    ok(`${number} created`, created.body?.ok === true,
      created.body?.ok ? "guarded and read back" : JSON.stringify(created.body?.errors ?? created.body).slice(0, 150));

    const d1 = await day();
    const mine = (d1?.vouchers ?? []).find((v: any) => v.voucherNumber === number);
    ok("it appears in the day's list", Boolean(mine), `${d1?.count} voucher(s) today`);
    ok("with the party and amount it was given",
      mine?.party === party && Math.abs(mine?.amount - 100) < 0.01,
      `${mine?.party} ₹${mine?.amount}`);
    const masterId = mine?.masterId;

    H("ALTER");
    const alt = await post("/api/local/push", {
      payload: { ...payload, action: "Alter", narration: "local session harness — CORRECTED" },
    });
    ok("the correction is accepted", alt.body?.ok === true,
      alt.body?.ok ? "" : JSON.stringify(alt.body?.errors ?? alt.body).slice(0, 150));
    const d2 = await day();
    const altered = (d2?.vouchers ?? []).find((v: any) => v.voucherNumber === number);
    ok("the narration changed in the books",
      altered?.narration === "local session harness — CORRECTED", altered?.narration);
    ok("and it is the same document", altered?.masterId === masterId,
      `${masterId} → ${altered?.masterId}`);

    H("CANCEL");
    const cancelled = await post("/api/local/push", { payload: { ...payload, action: "Cancel" } });
    ok("the cancel is accepted", cancelled.body?.ok === true,
      cancelled.body?.ok ? "" : JSON.stringify(cancelled.body?.errors ?? cancelled.body).slice(0, 150));
    const d3 = await day();
    const c = (d3?.vouchers ?? []).find((v: any) => v.voucherNumber === number);
    ok("the voucher still exists — a cancel is not a delete", Boolean(c));
    ok("and the books say it is cancelled", c?.isCancelled === true, String(c?.isCancelled));
    ok("it kept its number", c?.voucherNumber === number);
  } finally {
    H("DELETE — AND BACK WHERE WE STARTED");
    if (!pushed) console.log("    nothing was pushed.");
    else if (KEEP) console.log("    --keep: left in place.");
    else {
      const del = await post("/api/local/push", { payload: { ...payload, action: "Delete" } });
      ok("the delete is accepted", del.body?.ok === true,
        del.body?.ok ? "" : JSON.stringify(del.body?.errors ?? del.body).slice(0, 140));
      /* Verified by RE-READING the books. A delete response has been observed
         returning DELETED=1 alongside a LINEERROR. */
      const d4 = await day();
      ok("the voucher is gone",
        !(d4?.vouchers ?? []).some((v: any) => v.voucherNumber === number));
      ok("the day's count is back where it started", d4?.count === startCount,
        `${startCount} → ${d4?.count}`);
    }
  }

  console.log(`\n\x1b[1m${passed} passed · ${failed} failed\x1b[0m`);
  if (failed) console.log(`\nfailed:\n${failures.map((f) => `  · ${f}`).join("\n")}`);
  console.log();
  process.exit(failed ? 1 : 0);
})();

/* Makes this file a module. Without a top-level import or export, TypeScript
   treats a script as GLOBAL — so this file's `failures` collided with the one
   in the other import-free script, and `failures === 0` was comparing a
   string[] to a number in whichever lost. Six errors, one cause. */
export {};
