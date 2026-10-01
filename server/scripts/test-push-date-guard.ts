/**
 * The backdated-purchase refusals, offline — no Tally, no Supabase.
 *
 * Owner, 1-Oct-2026: Ludhiana bills are pushed on the date he confirms, often
 * the supplier's bill date. `backdatedPurchaseRefusals` (pushGuard.ts) refuses
 * such a Create when the date sits in a filed GST period or before the
 * supplier's GST registration came into force — BEFORE any request is built.
 *
 *   npx tsx scripts/test-push-date-guard.ts
 */
import { backdatedPurchaseRefusals, gstReturnFiledThrough, filedBoundaryFor } from "../src/services/pushGuard.js";
import type { MasterLedger, TallyMasters } from "../src/services/tallyMasters.js";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};

const ledger = (name: string, regs: MasterLedger["registrations"]): MasterLedger => ({
  name, parent: "Sundry Creditors", gstin: regs.at(-1)?.gstin ?? "", state: "Punjab", pincode: "141003",
  mailingName: name, address: ["G T ROAD, LUDHIANA"], registrations: regs,
});
const TOGO = ledger("TOGO CYCLES", [
  { applicableFrom: "20170701", gstin: "03ACUPA2463R1Z7", registrationType: "Regular", placeOfSupply: "Punjab", state: "Punjab" },
]);
const NEWCO = ledger("NEW SUPPLIER", [
  { applicableFrom: "20260915", gstin: "03AAAAA0000A1Z5", registrationType: "Regular", placeOfSupply: "Punjab", state: "Punjab" },
]);
const NOREG = ledger("UNREGISTERED", []);
const m = {
  ledgers: new Map([[TOGO.name, TOGO], [NEWCO.name, NEWCO], [NOREG.name, NOREG]]),
  ledgerLoose: new Map<string, string>(),
} as unknown as TallyMasters;

const p = (over: Record<string, unknown> = {}) => ({
  voucherType: "Purchase", action: "Create" as const, date: "2026-09-24", partyLedgerName: "TOGO CYCLES", ...over,
}) as Parameters<typeof backdatedPurchaseRefusals>[0];

console.log("filed period");
ok("a September bill date with August filed is accepted", backdatedPurchaseRefusals(p(), m, "2026-08-31").length === 0);
{
  const e = backdatedPurchaseRefusals(p({ date: "2026-08-27" }), m, "2026-08-31");
  ok("an August bill date with August filed is refused, naming the period", e.length === 1 && /already filed \(through 2026-08-31\)/.test(e[0]), e.join(" | "));
}
ok("the last filed day itself is refused", backdatedPurchaseRefusals(p({ date: "2026-08-31" }), m, "2026-08-31").length === 1);
ok("allowFiledPeriodEdit lets a deliberate revision through", backdatedPurchaseRefusals(p({ date: "2026-08-27", allowFiledPeriodEdit: true }), m, "2026-08-31").length === 0);
ok("no MKCP_FILED_THROUGH configured → no filed-period refusal", backdatedPurchaseRefusals(p({ date: "2026-08-27" }), m, "").length === 0);
ok("an Alter is left to the existing Alter rule", backdatedPurchaseRefusals(p({ date: "2026-08-27", action: "Alter" }), m, "2026-08-31").length === 0);
ok("a Sale is not this rule's business", backdatedPurchaseRefusals(p({ date: "2026-08-27", voucherType: "Sales" }), m, "2026-08-31").length === 0);

console.log("registration in force");
{
  const e = backdatedPurchaseRefusals(p({ partyLedgerName: "NEW SUPPLIER", date: "2026-09-10" }), m, "");
  ok("a bill dated before the supplier's registration is refused, naming its start", e.length === 1 && /starts 2026-09-15, after this bill's date 2026-09-10/.test(e[0]), e.join(" | "));
}
ok("the registration's own first day is accepted", backdatedPurchaseRefusals(p({ partyLedgerName: "NEW SUPPLIER", date: "2026-09-15" }), m, "").length === 0);
ok("a supplier registered since 2017 is accepted", backdatedPurchaseRefusals(p({ date: "2026-04-02" }), m, "").length === 0);
ok("a ledger with no dated registration is not refused here", backdatedPurchaseRefusals(p({ partyLedgerName: "UNREGISTERED" }), m, "").length === 0);
ok("an unknown ledger is left to the name rule", backdatedPurchaseRefusals(p({ partyLedgerName: "NOBODY" }), m, "").length === 0);

// ── The boundary when MKCP_FILED_THROUGH is unset (owner: "Monthly, by the 11th") ──
const d = (y: number, mo: number, day: number) => new Date(y, mo - 1, day);
ok("1-Oct: August is filed, September is not", gstReturnFiledThrough(d(2026, 10, 1)) === "2026-08-31", gstReturnFiledThrough(d(2026, 10, 1)));
ok("11-Oct (due day): still August", gstReturnFiledThrough(d(2026, 10, 11)) === "2026-08-31");
ok("12-Oct: September is filed", gstReturnFiledThrough(d(2026, 10, 12)) === "2026-09-30");
ok("5-Jan: crosses the year to 30-Nov", gstReturnFiledThrough(d(2027, 1, 5)) === "2026-11-30", gstReturnFiledThrough(d(2027, 1, 5)));
ok("15-Mar: February ends on the 28th", gstReturnFiledThrough(d(2027, 3, 15)) === "2027-02-28");
if (!(process.env.MKCP_FILED_THROUGH ?? "").trim()) {
  ok("a Payment is bound by no filed period", filedBoundaryFor("Payment", d(2026, 10, 1)) === "");
  ok("a Receipt / Journal / Contra likewise", ["Receipt", "JOURNAL", " Contra "].every((t) => filedBoundaryFor(t, d(2026, 10, 1)) === ""));
  ok("a SALES is bound by the calendar", filedBoundaryFor("SALES", d(2026, 10, 1)) === "2026-08-31");
  ok("a Purchase is bound by the calendar", filedBoundaryFor("Purchase", d(2026, 10, 1)) === "2026-08-31");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
