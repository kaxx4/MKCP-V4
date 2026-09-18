/**
 * The GSTR exception audit, against vouchers whose answer is known.
 *
 * Pure — no Tally, no Supabase. It exists because the audit's hardest failure
 * mode is silence: a check that never fires and a check that is not wired look
 * identical in a run that reports "0 exceptions". The appropriation check in
 * particular spent months absent while the file asserted it was impossible, and
 * a nightly gate reporting zero is exactly what that looked like.
 *
 * So every rule is asserted in BOTH directions — the voucher that must flag and
 * the voucher that must not.
 *
 *   npx tsx server/scripts/test-gstr-exceptions.ts
 */
import { auditVoucher, type AuditedVoucher, type ExceptionKind } from "../src/services/gstrExceptions.js";

let pass = 0, fail = 0;

function expect(what: string, v: AuditedVoucher, kind: ExceptionKind, want: boolean): void {
  const got = auditVoucher(v).some((e) => e.kind === kind);
  if (got === want) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${what}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${what} — expected ${want ? "" : "no "}${kind}, got ${got ? "" : "none"}`); }
}

/** A clean local B2B sales invoice carrying an appropriated discount line. */
function clean(): AuditedVoucher {
  return {
    entriesPopulated: true, voucherNumber: "26-27/0999", date: "20260411",
    voucherType: "Sales", party: "SOME DEALER", placeOfSupply: "West Bengal",
    partyGstin: "19AAAAA0000A1Z5", consigneeState: "West Bengal", narration: "",
    entries: [
      { ledgerName: "SOME DEALER", amount: -212.62, appropriateFor: "" },
      { ledgerName: "SALES ( GST W.B. )", amount: 202.50, appropriateFor: "" },
      { ledgerName: "OUTPUT CGST", amount: 5.06, appropriateFor: "" },
      { ledgerName: "OUTPUT SGST", amount: 5.06, appropriateFor: "" },
      { ledgerName: "ROUNDED OFF", amount: -0.12, appropriateFor: "" },
      { ledgerName: "TRADE DISCOUNTS / H.C.", amount: -9901, appropriateFor: "GST" },
    ],
  };
}
const edit = (f: (v: AuditedVoucher) => void): AuditedVoucher => { const v = clean(); f(v); return v; };

console.log("\n  GSTR EXCEPTION AUDIT\n  " + "─".repeat(56));

/* ── appropriation ─────────────────────────────────────────────────────────
   The four lines that must NOT be asked to appropriate are each asserted
   separately, because getting any one of them wrong flags every invoice in the
   book — the shape of the 431 false positives this check was withdrawn over. */
expect("an appropriated discount line is accepted", clean(), "unappropriated-adjustment", false);
expect("an unappropriated discount line is flagged",
  edit((v) => { v.entries[5].appropriateFor = ""; }), "unappropriated-adjustment", true);
expect("the party line is not asked to appropriate",
  edit((v) => { v.entries.splice(5, 1); }), "unappropriated-adjustment", false);
expect("the SALES ledger is not asked to appropriate",
  edit((v) => { v.entries.splice(5, 1); v.entries[1].ledgerName = "SALES ( GST CENTRAL )"; }),
  "unappropriated-adjustment", false);
expect("tax heads are not asked to appropriate",
  edit((v) => { v.entries.splice(5, 1); v.entries[2].ledgerName = "OUTPUT IGST"; v.entries.splice(3, 1);
                v.placeOfSupply = "Delhi"; v.consigneeState = "Delhi"; }),
  "unappropriated-adjustment", false);
expect("ROUNDED OFF is not asked to appropriate",
  edit((v) => { v.entries.splice(5, 1); }), "unappropriated-adjustment", false);
expect("a PURCHASE DISCOUNTS line is an adjustment, not revenue",
  edit((v) => { v.entries[5] = { ledgerName: "PURCHASE DISCOUNTS ( @ 5% )", amount: -100, appropriateFor: "" }; }),
  "unappropriated-adjustment", true);

/* ── place of supply, GSTIN, tax head ────────────────────────────────────── */
expect("a voucher with a place of supply is accepted", clean(), "no-place-of-supply", false);
expect("no place of supply is flagged",
  edit((v) => { v.placeOfSupply = ""; v.consigneeState = ""; }), "no-place-of-supply", true);
expect("CONSIGNEESTATENAME substitutes for a missing PLACEOFSUPPLY",
  edit((v) => { v.placeOfSupply = ""; }), "no-place-of-supply", false);
expect("a party with a GSTIN is accepted", clean(), "no-party-gstin", false);
expect("a named party without a GSTIN is flagged",
  edit((v) => { v.partyGstin = ""; }), "no-party-gstin", true);
expect("a CASH sale without a GSTIN is legitimately B2C",
  edit((v) => { v.partyGstin = ""; v.party = "CASH"; v.entries[0].ledgerName = "CASH"; }),
  "no-party-gstin", false);
expect("local supply with CGST+SGST is accepted", clean(), "tax-head-mismatch", false);
expect("inter-state supply carrying CGST/SGST is flagged",
  edit((v) => { v.placeOfSupply = "Delhi"; }), "tax-head-mismatch", true);
expect("inter-state supply carrying IGST is accepted",
  edit((v) => { v.placeOfSupply = "Delhi"; v.entries[2].ledgerName = "OUTPUT IGST"; v.entries.splice(3, 1); }),
  "tax-head-mismatch", false);
expect("an outward supply with no tax line at all is flagged",
  edit((v) => { v.entries.splice(2, 2); }), "no-tax-line", true);

/* ── what must never be audited ──────────────────────────────────────────── */
expect("a Payment carries no GST and is not audited",
  edit((v) => { v.voucherType = "Payment"; v.placeOfSupply = ""; v.consigneeState = ""; v.partyGstin = ""; }),
  "no-place-of-supply", false);
expect("a Purchase reaches GSTR-2, not GSTR-1, and is not audited",
  edit((v) => { v.voucherType = "Purchase"; v.partyGstin = ""; }), "no-party-gstin", false);
expect("a voucher whose entries Tally did not send is skipped, not flagged",
  edit((v) => { v.entriesPopulated = false; v.entries = []; }), "no-tax-line", false);

console.log(`\n  ${"─".repeat(56)}\n  ${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
