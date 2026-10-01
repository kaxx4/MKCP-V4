/**
 * PAY-P1 — offline assertions for the two safePush gaps behind "simple
 * payments and receipts don't log" (owner, 1-Oct-2026). No Tally, no Supabase.
 *
 *   npx tsx scripts/test-pay-p1.ts
 *
 * 1. diffStored failed a voucher Tally had stored, because an `On Account` sent
 *    on a ledger that keeps no bills (SALARY & BONUS, Indirect Expenses) is
 *    dropped by Tally. push_queue 25-Sep-2026, 1922-1926/26-27: created/altered
 *    = 1, then "bill ref "On Account" on "SALARY & BONUS": NOT STORED" → failed
 *    → archived by the operator, while the money was in the books.
 * 2. A taken number answered in words (`Voucher Number '1920/26-27' already
 *    exists!`, errors=1 exceptions=0) never reached the renumber retry.
 *
 * FIXTURES ARE HAND-BUILT, labelled as such: the read-back blocks below follow
 * the shape of Tally's MkVerify collection (ALLLEDGERENTRIES.LIST with an empty
 * BILLALLOCATIONS.LIST placeholder on a non-bill-wise line) — no live capture of
 * an expense-ledger payment exists in server/data. The LINEERROR string is
 * copied verbatim from push_queue row 7fe4ee34 (result.lineErrors[0]).
 */
import { diffStored, numberTakenError } from "../src/services/safePush.js";
import type { VoucherPayload } from "../src/types.js";

let passed = 0, failed = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
};

const payment = (ledger: string, amount: number, bills: VoucherPayload["ledgerEntries"][number]["billAllocations"]): VoucherPayload => ({
  voucherType: "Payment", date: "2026-09-25", voucherNumber: "1922/26-27",
  remoteId: `MKCP|Payment|BULK/P/20260925/${ledger}/1922/26-27|2026-27`,
  partyLedgerName: ledger, isInvoice: false, narration: "NEFT AS PER VOUCHER",
  ledgerEntries: [
    { ledgerName: ledger, amount, isDeemedPositive: true, isPartyLedger: true, billAllocations: bills },
    { ledgerName: "HDFC BANK", amount, isDeemedPositive: false, isPartyLedger: false },
  ],
} as VoucherPayload);

/** Hand-built read-back: `billBlock` is what Tally stored on the party line. */
const stored = (ledger: string, amount: number, billBlock: string) => `<VOUCHER>
<VOUCHERNUMBER>1922/26-27</VOUCHERNUMBER><VOUCHERTYPENAME>Payment</VOUCHERTYPENAME>
<ALLLEDGERENTRIES.LIST><LEDGERNAME>${ledger.replace(/&/g, "&amp;")}</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-${amount.toFixed(2)}</AMOUNT>
${billBlock}
</ALLLEDGERENTRIES.LIST>
<ALLLEDGERENTRIES.LIST><LEDGERNAME>HDFC BANK</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>${amount.toFixed(2)}</AMOUNT>
<BILLALLOCATIONS.LIST>      </BILLALLOCATIONS.LIST>
</ALLLEDGERENTRIES.LIST>
</VOUCHER>`;
const EMPTY = "<BILLALLOCATIONS.LIST>      </BILLALLOCATIONS.LIST>";
const bill = (name: string, type: string, amt: number) =>
  `<BILLALLOCATIONS.LIST><NAME>${name}</NAME><BILLTYPE>${type}</BILLTYPE><AMOUNT>-${amt.toFixed(2)}</AMOUNT></BILLALLOCATIONS.LIST>`;

console.log("\nPAY-P1 — On Account dropped on a ledger that keeps no bills");
{
  const d = diffStored(payment("SALARY & BONUS", 22214, [{ name: "On Account", billType: "On Account", amount: 22214 }]),
    stored("SALARY & BONUS", 22214, EMPTY));
  ok("SALARY & BONUS + On Account, stored with no allocation → no difference", d.length === 0, d.join("; "));
}
{
  const d = diffStored(payment("SALARY & BONUS", 22214, []), stored("SALARY & BONUS", 22214, EMPTY));
  ok("the new shape (no allocation sent) → no difference", d.length === 0, d.join("; "));
}
{
  const d = diffStored(payment("SALARY & BONUS", 22214, [{ name: "On Account", billType: "On Account", amount: 22214 }]),
    stored("SALARY & BONUS", 22000, EMPTY));
  ok("…but a wrong AMOUNT on that line is still a difference", d.some(x => /sent -22214, stored -22000/.test(x)), d.join("; "));
}

console.log("\nPAY-P1 — what must STILL be caught");
{
  const d = diffStored(payment("TOGO CYCLES", 5000, [{ name: "1176", billType: "Agst Ref", amount: 5000 }]),
    stored("TOGO CYCLES", 5000, EMPTY));
  ok("an Agst Ref that was not stored is still NOT STORED", d.some(x => /bill ref "1176".*NOT STORED/.test(x)), d.join("; "));
}
{
  const d = diffStored(payment("TOGO CYCLES", 5000, [{ name: "TI/26-27/34", billType: "Agst Ref", amount: 5000 }]),
    stored("TOGO CYCLES", 5000, bill("TI/26-27/34", "New Ref", 5000)));
  ok("the cross-party Agst Ref → New Ref rewrite is still caught", d.some(x => /type sent Agst Ref, stored New Ref/.test(x)), d.join("; "));
}
{
  const d = diffStored(payment("TOGO CYCLES", 500, [{ name: "On Account", billType: "On Account", amount: 500 }]),
    stored("TOGO CYCLES", 500, bill("On Account", "On Account", 500)));
  ok("a bill-wise On Account that WAS stored still verifies", d.length === 0, d.join("; "));
}
{
  const d = diffStored(payment("TOGO CYCLES", 500, [{ name: "On Account", billType: "On Account", amount: 500 }]),
    stored("TOGO CYCLES", 500, bill("1176", "Agst Ref", 500)));
  ok("On Account stored as something else is still a difference", d.length > 0, d.join("; "));
}

console.log("\nPAY-P1 — a taken number, answered in words");
// Verbatim from push_queue 7fe4ee34 (25-Sep-2026), entities as stored.
ok("`Voucher Number &apos;1920/26-27&apos; already exists!` is a taken number",
  numberTakenError(["Voucher Number &apos;1920/26-27&apos; already exists!"]));
ok("decoded form too", numberTakenError(["Voucher Number '1921/26-27' already exists!"]));
ok("a missing ledger is NOT a taken number", !numberTakenError(["Ledger \"AMRIT SALES ( INDIA )\" does not exist."]));
ok("no errors → not a taken number", !numberTakenError([]));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
