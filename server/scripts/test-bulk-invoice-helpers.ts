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
import { bulkKept, removalDate, removalVerdict, removalExit, removalCommand } from "./lib/bulkInvoice.js";

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
const gone = { invoiceDeleted: 1, invoiceStillThere: false, itemRemoved: true, itemStillThere: false, partyRemoved: true, partyStillThere: false };
ok("invoice, item and party all removed: removed", removalVerdict(gone) === "removed");
ok("invoice not deleted and still there: failed", removalVerdict({ ...gone, invoiceDeleted: 0, invoiceStillThere: true }) === "failed");
ok("party left: failed", removalVerdict({ ...gone, partyRemoved: false, partyStillThere: true }) === "failed");
// Review, 5-Nov-2026: a re-run on an invoice already gone.
ok("re-run: invoice, item and party already absent on read-back: already removed",
  removalVerdict({ invoiceDeleted: 0, invoiceStillThere: false, itemRemoved: false, itemStillThere: false, partyRemoved: false, partyStillThere: false }) === "already removed");
ok("invoice not deleted, absent on read-back, item and party removed now: already removed",
  removalVerdict({ ...gone, invoiceDeleted: 0 }) === "already removed");
ok("removalExit: removed and already removed exit 0, failed exits 1",
  removalExit("removed") === 0 && removalExit("already removed") === 0 && removalExit("failed") === 1);

console.log("\n  a send that threw");
ok("safePush threw (a timeout after Tally may have accepted): kept", bulkKept("threw", false));

console.log("\n  the LEFT IN PLACE hint is the whole command");
const cmd = removalCommand("C:/scratch/c13", "393119", "20261105");
ok("it names the evidence folder", cmd.includes('"C:/scratch/c13"'));
ok("it names the stamp and the date", cmd.includes("--remove-stamp=393119") && cmd.includes("--remove-date=20261105"));
ok("it runs the same script with the env file", cmd.includes("npx tsx --env-file=.env scripts/test-batch04-dummy.ts"));

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
