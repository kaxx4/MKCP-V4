/**
 * Place of supply: what the payload may declare, and what it must never override.
 *
 * PURE — this never contacts Tally. Every rule here decides CGST+SGST vs IGST,
 * which is not visible in a read-back diff: a mis-taxed voucher balances, imports
 * cleanly and reads back identical, and is only wrong in the return. So the rules
 * are pinned here rather than being inferred from a live push.
 *
 * The live half lives in test-cash-invoice-converter.ts, which proves a walk-in
 * reaches Tally and comes back carrying "West Bengal". That harness deliberately
 * picks a WEST BENGAL debtor for its party case, so its "the party's own state
 * was not overwritten" check compares West Bengal to West Bengal and cannot fail.
 * THE CROSS-STATE CASE IS ONLY COVERED HERE.
 *
 *   npx tsx scripts/test-place-of-supply.ts
 */
import { guardVoucher, resolvePartyState, isInwardSupply, HOME_STATE_NAME } from "../src/services/pushGuard.js";
import type { TallyMasters, MasterLedger } from "../src/services/tallyMasters.js";
import type { VoucherPayload } from "../src/types.js";

let passed = 0, failed = 0;
const failures: string[] = [];
function ok(label: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`    \x1b[32m✓\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`); }
  else { failed++; failures.push(label); console.log(`    \x1b[31m✗ ${label}\x1b[0m${detail ? ` — ${detail}` : ""}`); }
}
const H = (s: string) => console.log(`\n\x1b[1m── ${s} ${"─".repeat(Math.max(0, 58 - s.length))}\x1b[0m`);

const ledger = (name: string, state: string, parent = "SUNDRY DEBTORS"): MasterLedger => ({
  name, parent, gstin: state ? "19AAAAA0000A1Z5" : "", state, pincode: "700001",
  mailingName: name, address: [], registrations: [],
});

/** Just enough masters for the guard: it resolves names, states and rates. */
function masters(): TallyMasters {
  const ledgers = new Map<string, MasterLedger>();
  const ledgerLoose = new Map<string, string>();
  for (const l of [
    ledger("Cash", "", "CASH-IN-HAND"),          // the real one: no state, and cannot have one
    ledger("WB DEALER", "West Bengal"),
    ledger("PUNJAB DEALER", "Punjab"),
    ledger("SALES  ( GST W.B. )", "", "SALES ACCOUNTS"),
    ledger("SALES  ( GST CENTRAL )", "", "SALES ACCOUNTS"),
    ledger("OUTPUT CGST", "", "DUTIES & TAXES"),
    ledger("OUTPUT SGST", "", "DUTIES & TAXES"),
    ledger("OUTPUT IGST", "", "DUTIES & TAXES"),
    ledger("PURCHASE  ( GST CENTRAL )", "", "PURCHASE ACCOUNTS"),
  ]) { ledgers.set(l.name, l); ledgerLoose.set(l.name.toLowerCase().replace(/\s+/g, " "), l.name); }

  return {
    company: "TEST", loadedAt: Date.now(), ledgers, ledgerLoose,
    items: new Map(), itemLoose: new Map(), stockGroups: new Map(),
    godowns: new Set(["Main Location"]), units: new Set(["PC"]),
    voucherTypes: new Set(["Sales", "Purchase", "Sales Order Note", "Payment"]),
  };
}
const M = masters();

/** A minimal accounting-only sale; no inventory, so the GSTR-1 block stays out
 *  of the way and each test isolates the one rule it is about. */
function sale(over: Partial<VoucherPayload> = {}): VoucherPayload {
  const party = over.partyLedgerName ?? "Cash";
  return {
    voucherType: "Sales", date: "2026-09-12", voucherNumber: "T/1",
    remoteId: "T/1", partyLedgerName: party, isInvoice: true,
    ledgerEntries: [
      { ledgerName: party, amount: 118, isDeemedPositive: true, isPartyLedger: true },
      { ledgerName: "SALES  ( GST W.B. )", amount: 100, isDeemedPositive: false, isPartyLedger: false, appropriateToGst: "Goods" },
      { ledgerName: "OUTPUT CGST", amount: 9, isDeemedPositive: false, isPartyLedger: false },
      { ledgerName: "OUTPUT SGST", amount: 9, isDeemedPositive: false, isPartyLedger: false },
    ],
    ...over,
  };
}
const errs = (p: VoucherPayload) => guardVoucher(p, M).errors.join(" | ");
const warns = (p: VoucherPayload) => guardVoucher(p, M).warnings.join(" | ");

(function run() {
  console.log(`\n\x1b[1mPlace of supply — declaration rules\x1b[0m`);

  H("THE RESOLVER");
  ok("a ledger with a state wins, and the payload is ignored",
    resolvePartyState({ voucherType: "Sales", placeOfSupply: "Punjab" }, "West Bengal").state === "West Bengal");
  ok("that case reports its source as the ledger",
    resolvePartyState({ voucherType: "Sales", placeOfSupply: "Punjab" }, "West Bengal").source === "ledger");
  ok("a stateless ledger takes the declaration on an outward voucher",
    resolvePartyState({ voucherType: "Sales", placeOfSupply: "Punjab" }, "").state === "Punjab");
  ok("and reports that it came from the payload",
    resolvePartyState({ voucherType: "Sales", placeOfSupply: "Punjab" }, "").source === "payload");
  ok("a declaration is NOT used on an inward voucher",
    resolvePartyState({ voucherType: "Purchase", placeOfSupply: "Punjab" }, "").state === "");
  ok("nothing anywhere resolves to nothing",
    resolvePartyState({ voucherType: "Sales" }, "").source === "none");
  ok("whitespace is not a state",
    resolvePartyState({ voucherType: "Sales", placeOfSupply: "   " }, "  ").source === "none");

  H("DIRECTION");
  for (const t of ["Purchase", "Debit Note", "Receipt Note"]) {
    ok(`${t} is inward`, isInwardSupply(t));
  }
  for (const t of ["Sales", "Credit Note", "Sales Order Note", "Delivery Note"]) {
    ok(`${t} is outward`, !isInwardSupply(t));
  }

  H("THE WALK-IN — THE CASE THIS EXISTS FOR");
  const walkIn = sale({ placeOfSupply: "West Bengal" });
  ok("a Cash sale declaring West Bengal is accepted", guardVoucher(walkIn, M).ok, errs(walkIn));
  ok("and says out loud where the state came from",
    /comes from the payload/i.test(warns(walkIn)));

  const bare = sale();
  ok("the same sale with NO declaration still warns that the state is missing",
    /no state on its ledger master/i.test(warns(bare)));

  H("WHAT A DECLARATION MUST NOT DO");
  const contradiction = sale({ partyLedgerName: "PUNJAB DEALER", placeOfSupply: "West Bengal" });
  ok("it cannot contradict a ledger that already has a state",
    /contradicts the state on ledger/i.test(errs(contradiction)), errs(contradiction).slice(0, 90));

  /* The cross-state leak. The live harness cannot see this: its party is in West
     Bengal, so an override would land on the same value it was meant to replace. */
  const agreeing = sale({ partyLedgerName: "PUNJAB DEALER", placeOfSupply: "Punjab" });
  ok("a Punjab party is still judged interstate — a local tax head is refused",
    /interstate/i.test(errs(agreeing)), errs(agreeing).slice(0, 90));

  const purchase: VoucherPayload = {
    voucherType: "Purchase", date: "2026-09-12", voucherNumber: "T/2", remoteId: "T/2",
    partyLedgerName: "Cash", isInvoice: true, placeOfSupply: "Punjab",
    ledgerEntries: [
      { ledgerName: "Cash", amount: 100, isDeemedPositive: false, isPartyLedger: true },
      { ledgerName: "PURCHASE  ( GST CENTRAL )", amount: 100, isDeemedPositive: true, isPartyLedger: false, appropriateToGst: "Goods" },
    ],
  };
  ok("it is REFUSED on an inward voucher rather than ignored",
    /not accepted on Purchase/i.test(errs(purchase)), errs(purchase).slice(0, 100));

  const typo = sale({ placeOfSupply: "West Bangal" });
  ok("a misspelt state is refused, not taxed on",
    /not a state any ledger in this company uses/i.test(errs(typo)), errs(typo).slice(0, 90));

  H("THE TAX HEAD FOLLOWS THE DECLARATION");
  const igstWalkIn = sale({
    placeOfSupply: "West Bengal",
    ledgerEntries: [
      { ledgerName: "Cash", amount: 118, isDeemedPositive: true, isPartyLedger: true },
      { ledgerName: "SALES  ( GST CENTRAL )", amount: 100, isDeemedPositive: false, isPartyLedger: false, appropriateToGst: "Goods" },
      { ledgerName: "OUTPUT IGST", amount: 18, isDeemedPositive: false, isPartyLedger: false },
    ],
  });
  ok("a walk-in billed as IGST is refused — the shop is in West Bengal",
    /local transaction/i.test(errs(igstWalkIn)), errs(igstWalkIn).slice(0, 90));
  ok("and the message blames the declaration, not the Cash ledger",
    /declares its place of supply/i.test(errs(igstWalkIn)));

  ok(`home state is spelled as Tally stores it`, HOME_STATE_NAME === "West Bengal");

  console.log(`\n\x1b[1m${passed} passed · ${failed} failed\x1b[0m`);
  if (failed) console.log(`\nfailed:\n${failures.map((f) => `  · ${f}`).join("\n")}`);
  console.log();
  process.exit(failed ? 1 : 0);
})();
