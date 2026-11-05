/**
 * The C13 bulk-invoice harness (test-batch04-dummy.ts --only=bulk), its pure
 * decisions, offline. Added 5-Nov-2026 after the review of 0-7:
 *  - a bulk invoice counts as LEFT IN PLACE whenever it may be in the books:
 *    found on read-back, or sent at all (safePush got past its guard). Only a
 *    guard refusal sends nothing.
 *  - --remove-stamp deletes with the invoice's own creation date, from
 *    --remove-date=YYYYMMDD or the run's summary.json; it never guesses today.
 *  - the removal succeeds only when the invoice itself was deleted.
 *
 *   npx tsx server/scripts/test-bulk-invoice-helpers.ts
 */
import { bulkKept, removalDate, removalOk } from "./lib/bulkInvoice.js";

let pass = 0, fail = 0;
const ok = (what: string, cond: boolean) => { if (cond) { pass++; console.log(`  ok    ${what}`); } else { fail++; console.log(`  FAIL  ${what}`); } };

console.log("\n  left in place?");
ok("stored and read back: kept", bulkKept({ ok: true, stage: "done" }, true));
ok("stored but the read-back differs (ok false, voucher found): kept", bulkKept({ ok: false, stage: "verify" }, true));
ok("sent but not found on read-back: kept (it may still be in the books)", bulkKept({ ok: false, stage: "verify" }, false));
ok("Tally answered with an exception after sending: kept", bulkKept({ ok: false, stage: "push" }, false));
ok("refused by the guard, nothing sent: not kept", !bulkKept({ ok: false, stage: "guard" }, false));

console.log("\n  the date the removal uses");
const summary = { stamp: "393119", bulk: { stamp: "393119", number: "ZZTEST/BULK393119", date: "20261105" } };
const d = (r: ReturnType<typeof removalDate>) => ("date" in r ? r.date : `error: ${r.error}`);
ok("--remove-date wins", d(removalDate(["--remove-stamp=393119", "--remove-date=20261104"], summary, "393119")) === "20261104");
ok("else the run's summary.json, for the same stamp", d(removalDate(["--remove-stamp=393119"], summary, "393119")) === "20261105");
ok("a summary for another stamp is not used", "error" in removalDate(["--remove-stamp=111111"], summary, "111111"));
ok("no date anywhere is refused, never today's", "error" in removalDate(["--remove-stamp=393119"], null, "393119"));
ok("a malformed --remove-date is refused", "error" in removalDate(["--remove-date=2026-11-05"], summary, "393119"));

console.log("\n  the exit code");
ok("invoice, item and party all removed: success", removalOk(1, true, true));
ok("invoice not deleted: failure, even when item and party went", !removalOk(0, true, true));
ok("party left: failure", !removalOk(1, true, false));

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
