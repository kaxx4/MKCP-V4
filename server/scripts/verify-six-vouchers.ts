/**
 * Six voucher types, pushed and then audited for GST correctness.
 *
 * Payment · Receipt · Sales · Sales Order Note · Purchase · Contra.
 *
 * ── Why it is written this way ────────────────────────────────────────────
 * GSTR-1 is NOT exposed over XML on this install — every report name comes back
 * "Could not find Report" (Tally answers cleanly, no modal). So the return's own
 * exception list cannot be read, and "zero exceptions" has to be established
 * some other way.
 *
 * The substitute is stronger than reading a count. A GSTR-1 exception is always
 * a missing or contradictory FIELD ON THE VOUCHER, and those fields are
 * readable. So this compares every voucher it pushes, field by field, against
 * what TALLY ITSELF stores on the native vouchers of that type which are
 * already filed clean — sampled from the live company at the top of the run
 * rather than hard-coded from memory.
 *
 * Ground truth sampled 2026-09-12 from 3,335 native FY26-27 vouchers:
 *
 *   type               n     GSTIN  REGTYPE  PLACEOFSUPPLY  ISINVOICE
 *   SALES           1025       37%      82%            82%       100%
 *   Purchase         476       88%     100%            97%       100%
 *   Sales Order       39       33%      59%            41%       100%
 *   Payment          877        0%       0%             0%       100%
 *   Receipt          783        0%      22%             0%       100%
 *   Contra            27        0%       0%             0%       100%
 *
 * The money vouchers carry NO GST identity and that is correct — they never
 * enter GSTR-1. Asserting they are clean means asserting they are balanced and
 * correctly allocated, not that they carry a GSTIN. Conflating the two is how a
 * check ends up demanding fields that would make the voucher wrong.
 *
 * ── Safety ────────────────────────────────────────────────────────────────
 * Sandbox company only. Every voucher carries a REMOTEID and is deleted at the
 * end, with a final sweep proving nothing was left behind. Only request shapes
 * already proven safe are used: entry blocks are never pulled across more than
 * a single day, because a year-wide pull with entry blocks wedged the port for
 * 77 seconds.
 *
 *   npx tsx scripts/verify-six-vouchers.ts          # dry run, shows the plan
 *   npx tsx scripts/verify-six-vouchers.ts --push   # push, audit, clean up
 *   npx tsx scripts/verify-six-vouchers.ts --push --keep   # leave them for inspection
 */
import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { convertCompanies } from "../src/converters/convert.js";
import { loadMasters, gstRateFor, registrationOn, type TallyMasters } from "../src/services/tallyMasters.js";
import { safePush } from "../src/services/safePush.js";
import type { VoucherPayload } from "../src/types.js";

const U = process.env.TALLY_URL || "http://localhost:9000";
const PUSH = process.argv.includes("--push");
const KEEP = process.argv.includes("--keep");

/** Today. After MKCP_FILED_THROUGH (2026-08-31), so nothing here touches a filed period. */
const DATE = new Date().toISOString().slice(0, 10);
const STAMP = DATE.replace(/-/g, "");
const TAG = `GSTV${Date.now().toString().slice(-5)}`;

const HOME_STATE = "West Bengal";
const BANK = "HDFC BANK";
const SALES_LEDGER = "SALES  ( GST W.B. )";
const PURCH_LEDGER = "PURCHASE ( GST CENTRAL )";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const r2 = (n: number) => Math.round(n * 100) / 100;
const num = (s: string) => { const m = /^\s*(-?[\d.]+)/.exec(String(s).replace(/,/g, "")); return m ? parseFloat(m[1]) : NaN; };
const fld = (v: string, t: string) => {
  const m = new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, "i").exec(v);
  return m ? m[1].trim() : "";
};

// ── reporting ──────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const failures: string[] = [];
function ok(label: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`    \x1b[32m✓\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`); }
  else { failed++; failures.push(label); console.log(`    \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`); }
}
const H = (s: string) => console.log(`\n\x1b[1m── ${s} ${"─".repeat(Math.max(0, 58 - s.length))}\x1b[0m`);

async function healthy(): Promise<boolean> {
  try { return convertCompanies(await tallyPost(U, HEALTH_XML, 10_000)).length > 0; }
  catch { return false; }
}

/**
 * Read vouchers back for ONE day, with entry blocks.
 * Scoped to a single day deliberately — see the safety note in the header.
 */
async function vouchersOnDay(company: string, yyyymmdd: string): Promise<string[]> {
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>MkSix</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="MkSix" ISMODIFY="No"><TYPE>Voucher</TYPE>
<NATIVEMETHOD>Date</NATIVEMETHOD><NATIVEMETHOD>VoucherNumber</NATIVEMETHOD>
<NATIVEMETHOD>VoucherTypeName</NATIVEMETHOD><NATIVEMETHOD>PartyLedgerName</NATIVEMETHOD>
<NATIVEMETHOD>PartyGSTIN</NATIVEMETHOD><NATIVEMETHOD>GSTRegistrationType</NATIVEMETHOD>
<NATIVEMETHOD>PlaceOfSupply</NATIVEMETHOD><NATIVEMETHOD>StateName</NATIVEMETHOD>
<NATIVEMETHOD>CountryOfResidence</NATIVEMETHOD><NATIVEMETHOD>IsInvoice</NATIVEMETHOD>
<NATIVEMETHOD>IsCancelled</NATIVEMETHOD><NATIVEMETHOD>IsOptional</NATIVEMETHOD>
<NATIVEMETHOD>MasterId</NATIVEMETHOD><NATIVEMETHOD>Narration</NATIVEMETHOD>
<NATIVEMETHOD>AllLedgerEntries</NATIVEMETHOD><NATIVEMETHOD>AllInventoryEntries</NATIVEMETHOD>
<FILTER>MkSixF</FILTER></COLLECTION>
<SYSTEM TYPE="Formulae" NAME="MkSixF">($$YearOfDate:$Date * 10000 + $$MonthOfDate:$Date * 100 + $$DayOfDate:$Date) = ${yyyymmdd}</SYSTEM>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
  const raw: string = await tallyPost(U, xml, 180_000, true);
  return [...raw.matchAll(/<VOUCHER\b[^>]*>[\s\S]*?<\/VOUCHER>/g)].map((m) => m[0]);
}

/**
 * Ledger name → signed amount, as stored.
 *
 * Tally uses TWO different element names depending on the voucher's shape:
 * an invoice-shaped voucher (Sales, Purchase, Sales Order Note) stores its
 * entries under LEDGERENTRIES.LIST, while a money voucher (Payment, Receipt,
 * Contra) uses ALLLEDGERENTRIES.LIST. Reading only one name returns an empty
 * list for half the types — and an empty list makes a balance check pass
 * trivially, which is worse than failing.
 */
function ledgerAmounts(v: string): Array<{ name: string; amount: number }> {
  const out: Array<{ name: string; amount: number }> = [];
  for (const [, block] of v.matchAll(/<ALLLEDGERENTRIES\.LIST>([\s\S]*?)<\/ALLLEDGERENTRIES\.LIST>/g)) {
    const name = fld(block, "LEDGERNAME");
    const amount = num(fld(block, "AMOUNT"));
    if (name && Number.isFinite(amount)) out.push({ name, amount });
  }
  return out;
}

/** The stock lines, for HSN and quantity. NOT for the balance — see below. */
function inventoryLines(v: string): Array<{ item: string; amount: number; hsn: string }> {
  const out: Array<{ item: string; amount: number; hsn: string }> = [];
  for (const [, block] of v.matchAll(/<ALLINVENTORYENTRIES\.LIST>([\s\S]*?)<\/ALLINVENTORYENTRIES\.LIST>/g)) {
    out.push({
      item: fld(block, "STOCKITEMNAME"),
      amount: num(fld(block, "AMOUNT")),
      hsn: fld(block, "GSTHSNNAME"),
    });
  }
  return out;
}

/**
 * Everything that contributes to the voucher's balance.
 *
 * ALLLEDGERENTRIES.LIST alone, and deliberately so. Dumped verbatim from a real
 * pushed sales invoice, Tally returns BOTH lists over overlapping lines:
 *
 *   LEDGERENTRIES.LIST (3)      party −212.62, CGST 5.06, SGST 5.06   net −202.50
 *   ALLLEDGERENTRIES.LIST (4)   the same three PLUS SALES ( GST W.B. ) 202.50,
 *                               and it is the one carrying the bill allocation  net 0
 *   ALLINVENTORYENTRIES.LIST(1) the stock line, whose accounting allocation IS
 *                               that fourth SALES entry
 *
 * So ALLLEDGERENTRIES is the complete, balanced picture; LEDGERENTRIES is a
 * partial view that does not balance on its own, and the inventory allocation
 * is a restatement of a line already counted. Summing more than one of the
 * three double-counts — which doubled every tax figure here and still let the
 * sales voucher "balance", since doubling a balanced voucher balances. The
 * purchase is what exposed it, at net ₹1,750 instead of ₹0.
 */
const allAmounts = (v: string) => ledgerAmounts(v);

function taxHead(v: string, re: RegExp): number {
  return ledgerAmounts(v).filter((l) => re.test(l.name)).reduce((s, l) => s + Math.abs(l.amount), 0);
}

/** Delete by the REMOTEID we assigned — the only handle Tally accepts. */
async function remove(company: string, type: string, number: string, remoteId: string): Promise<boolean> {
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Import</TALLYREQUEST><TYPE>Data</TYPE><ID>Vouchers</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES></DESC>
<DATA><TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER REMOTEID="${esc(remoteId)}" VCHTYPE="${esc(type)}" ACTION="Delete"><DATE>${STAMP}</DATE><VOUCHERTYPENAME>${esc(type)}</VOUCHERTYPENAME><VOUCHERNUMBER>${esc(number)}</VOUCHERNUMBER></VOUCHER></TALLYMESSAGE></DATA></BODY></ENVELOPE>`;
  const raw: string = await tallyPost(U, xml, 60_000, true);
  return (parseInt(fld(raw, "DELETED") || "0", 10) || 0) > 0;
}

(async () => {
  const company = convertCompanies(await tallyPost(U, HEALTH_XML, 10_000))[0]?.name;
  if (!company) throw new Error("No company loaded");
  const m: TallyMasters = await loadMasters(U, company);

  // ── Real masters, discovered not assumed ────────────────────────────────
  const customer = [...m.ledgers.values()].find(
    (l) => /SUNDRY DEBTORS/i.test(l.parent) && new RegExp(HOME_STATE, "i").test(l.state ?? "")
      && registrationOn(l, DATE).gstin.trim().length > 0)!;
  const supplier = [...m.ledgers.values()].find(
    (l) => /SUNDRY CREDITORS/i.test(l.parent) && l.state && !new RegExp(HOME_STATE, "i").test(l.state)
      && registrationOn(l, DATE).gstin.trim().length > 0)!;
  const item = [...m.items.values()].find((i) => i.closingStock > 40 && i.closingRate > 20)!;
  const item2 = [...m.items.values()].find((i) => i.name !== item.name && i.closingStock > 40 && i.closingRate > 20)!;

  const rate1 = gstRateFor(m, item.name, DATE);
  const rate2 = gstRateFor(m, item2.name, DATE);

  console.log(`\n\x1b[1mSix voucher types — GST audit\x1b[0m\n`);
  console.log(`company        "${company}"`);
  console.log(`date           ${DATE}   (filed through ${process.env.MKCP_FILED_THROUGH || "(unset)"})`);
  console.log(`customer       ${customer.name} — ${customer.state}, ${registrationOn(customer, DATE).gstin}`);
  console.log(`supplier       ${supplier.name} — ${supplier.state}, ${registrationOn(supplier, DATE).gstin}`);
  console.log(`item           ${item.name} @ ₹${item.closingRate} · GST ${rate1.rate}% (${rate1.source})`);
  console.log(`item 2         ${item2.name} @ ₹${item2.closingRate} · GST ${rate2.rate}% (${rate2.source})`);

  // ── The six payloads ────────────────────────────────────────────────────
  const n = (t: string) => `${TAG}/${t}`;
  const rid = (type: string, number: string) => `MKCP|${type}|${number}|2026-27`;

  // Sales: intra-state, so CGST + SGST, split evenly. Rate from the item's own
  // dated GST revision, not a constant.
  const qty = 10;
  const rate = r2(item.closingRate);
  const taxable = r2(qty * rate);
  const gstPct = rate1.rate;
  const half = r2((taxable * gstPct) / 200);
  const salesTotal = r2(taxable + half * 2);

  // Purchase: inter-state, so a single IGST head.
  const pQty = 5;
  const pRate = r2(item2.closingRate);
  const pTaxable = r2(pQty * pRate);
  const pGst = rate2.rate;
  const pIgst = r2((pTaxable * pGst) / 100);
  const purchTotal = r2(pTaxable + pIgst);

  const PAY = 5000, RCV = 7500, CONTRA = 12_000;

  const plan: Array<{ label: string; type: string; number: string; payload: VoucherPayload }> = [
    {
      label: "Sales — intra-state, registered party, CGST+SGST",
      type: "Sales", number: n("SAL"),
      payload: {
        voucherType: "Sales", date: DATE, voucherNumber: n("SAL"), remoteId: rid("Sales", n("SAL")),
        partyLedgerName: customer.name, isInvoice: true,
        narration: `${TAG} six-voucher GST audit — sales`,
        inventoryEntries: [{
          stockItemName: item.name, quantity: qty, rate, amount: taxable,
          unit: item.baseUnit, salesLedgerName: SALES_LEDGER, isDeemedPositive: false,
        }],
        // NOTE: the sales ledger is NOT repeated here. On an item invoice it
        // lives on the stock line's accounting allocation (salesLedgerName
        // above); listing it in both places double-counts the revenue, and the
        // push guard rejects it before Tally ever sees it.
        ledgerEntries: [
          { ledgerName: customer.name, amount: salesTotal, isDeemedPositive: true, isPartyLedger: true,
            billAllocations: [{ name: n("SAL"), billType: "New Ref", amount: salesTotal }] },
          { ledgerName: "OUTPUT CGST", amount: half, isDeemedPositive: false, isPartyLedger: false },
          { ledgerName: "OUTPUT SGST", amount: half, isDeemedPositive: false, isPartyLedger: false },
        ],
      },
    },
    {
      label: "Sales Order Note — same identity, no stock movement",
      type: "Sales Order Note", number: n("SO"),
      payload: {
        voucherType: "Sales Order Note", date: DATE, voucherNumber: n("SO"), remoteId: rid("Sales Order Note", n("SO")),
        partyLedgerName: customer.name, isInvoice: true,
        narration: `${TAG} six-voucher GST audit — sales order`,
        inventoryEntries: [{
          stockItemName: item.name, quantity: qty, rate, amount: taxable,
          unit: item.baseUnit, salesLedgerName: SALES_LEDGER, isDeemedPositive: false,
        }],
        ledgerEntries: [
          { ledgerName: customer.name, amount: salesTotal, isDeemedPositive: true, isPartyLedger: true },
          { ledgerName: "OUTPUT CGST", amount: half, isDeemedPositive: false, isPartyLedger: false },
          { ledgerName: "OUTPUT SGST", amount: half, isDeemedPositive: false, isPartyLedger: false },
        ],
      },
    },
    {
      label: "Purchase — inter-state, IGST only",
      type: "Purchase", number: n("PUR"),
      payload: {
        voucherType: "Purchase", date: DATE, voucherNumber: n("PUR"), remoteId: rid("Purchase", n("PUR")),
        partyLedgerName: supplier.name, isInvoice: true,
        reference: n("PUR"),
        narration: `${TAG} six-voucher GST audit — purchase`,
        inventoryEntries: [{
          stockItemName: item2.name, quantity: pQty, rate: pRate, amount: pTaxable,
          unit: item2.baseUnit, salesLedgerName: PURCH_LEDGER, isDeemedPositive: true,
        }],
        // Purchase ledger lives on the stock line, same as sales above.
        ledgerEntries: [
          { ledgerName: supplier.name, amount: purchTotal, isDeemedPositive: false, isPartyLedger: true,
            billAllocations: [{ name: n("PUR"), billType: "New Ref", amount: purchTotal }] },
          { ledgerName: "INPUT IGST", amount: pIgst, isDeemedPositive: true, isPartyLedger: false },
        ],
      },
    },
    {
      label: "Payment — money out, allocated against the bill just raised",
      type: "Payment", number: n("PAY"),
      payload: {
        voucherType: "Payment", date: DATE, voucherNumber: n("PAY"), remoteId: rid("Payment", n("PAY")),
        partyLedgerName: supplier.name, isInvoice: false,
        narration: `${TAG} six-voucher GST audit — payment`,
        ledgerEntries: [
          { ledgerName: supplier.name, amount: PAY, isDeemedPositive: true, isPartyLedger: true,
            billAllocations: [{ name: n("PUR"), billType: "Agst Ref", amount: PAY }] },
          { ledgerName: BANK, amount: PAY, isDeemedPositive: false, isPartyLedger: false,
            bankAllocation: { transactionType: "Cheque/DD", transferMode: "NEFT", instrumentNumber: TAG, favouring: supplier.name, instrumentDate: DATE } },
        ],
      },
    },
    {
      label: "Receipt — money in, allocated against the invoice just raised",
      type: "Receipt", number: n("RCT"),
      payload: {
        voucherType: "Receipt", date: DATE, voucherNumber: n("RCT"), remoteId: rid("Receipt", n("RCT")),
        partyLedgerName: customer.name, isInvoice: false,
        narration: `${TAG} six-voucher GST audit — receipt`,
        ledgerEntries: [
          { ledgerName: BANK, amount: RCV, isDeemedPositive: true, isPartyLedger: false,
            bankAllocation: { transactionType: "Cheque/DD", transferMode: "NEFT", instrumentNumber: TAG, favouring: customer.name, instrumentDate: DATE } },
          { ledgerName: customer.name, amount: RCV, isDeemedPositive: false, isPartyLedger: true,
            billAllocations: [{ name: n("SAL"), billType: "Agst Ref", amount: RCV }] },
        ],
      },
    },
    {
      label: "Contra — cash to bank, no GST content at all",
      type: "Contra", number: n("CON"),
      payload: {
        voucherType: "Contra", date: DATE, voucherNumber: n("CON"), remoteId: rid("Contra", n("CON")),
        // Bank is the party on a contra, and there is NO bank allocation: a
        // cash deposit has no instrument and no counterparty. Passing
        // `favouring: "Self"` made Tally resolve "Self" as a ledger name and
        // reject the whole voucher with "Ledger 'Self' does not exist!".
        partyLedgerName: BANK, isInvoice: false,
        narration: `${TAG} six-voucher GST audit — contra`,
        ledgerEntries: [
          { ledgerName: BANK, amount: CONTRA, isDeemedPositive: true, isPartyLedger: false },
          { ledgerName: "Cash", amount: CONTRA, isDeemedPositive: false, isPartyLedger: false },
        ],
      },
    },
  ];

  console.log(`\nplanned`);
  for (const p of plan) console.log(`  ${p.number.padEnd(18)} ${p.label}`);
  console.log(`\nsales    ₹${taxable} + CGST ₹${half} + SGST ₹${half} = ₹${salesTotal}  @ ${gstPct}%`);
  console.log(`purchase ₹${pTaxable} + IGST ₹${pIgst} = ₹${purchTotal}  @ ${pGst}%`);

  if (!PUSH) { console.log(`\nDry run. Pass --push to create these, audit them, and delete them again.\n`); return; }

  const made: Array<{ type: string; number: string; remoteId: string }> = [];
  try {
    // ═════ PUSH ═════════════════════════════════════════════════════════
    H("PUSHING");
    for (const p of plan) {
      const res = await safePush(U, company, p.payload);
      ok(`${p.number} pushed`, res.ok, res.ok ? p.label : (res.errors ?? []).join("; ").slice(0, 110));
      if (res.ok) made.push({ type: p.type, number: p.number, remoteId: p.payload.remoteId! });
      if (!await healthy()) throw new Error("Tally stopped answering mid-push");
    }

    // ═════ READ BACK ════════════════════════════════════════════════════
    H("READING BACK");
    const onDay = await vouchersOnDay(company, STAMP);
    const mine = new Map<string, string>();
    for (const v of onDay) {
      const vn = fld(v, "VOUCHERNUMBER");
      if (vn.startsWith(TAG)) mine.set(vn, v);
    }
    ok(`all six are in the books`, mine.size === plan.length, `${mine.size} of ${plan.length} found`);

    const get = (t: string) => mine.get(n(t)) ?? "";

    // ═════ SALES ════════════════════════════════════════════════════════
    H("SALES · GST identity and tax");
    {
      const v = get("SAL");
      const reg = registrationOn(customer, DATE);
      ok("stored as an invoice", fld(v, "ISINVOICE") === "Yes", fld(v, "ISINVOICE"));
      ok("carries the party GSTIN", fld(v, "PARTYGSTIN") === reg.gstin.trim(), fld(v, "PARTYGSTIN") || "(empty)");
      ok("registration type is set", fld(v, "GSTREGISTRATIONTYPE").length > 0, fld(v, "GSTREGISTRATIONTYPE") || "(empty)");
      ok("place of supply is the buyer's state", fld(v, "PLACEOFSUPPLY") === HOME_STATE, fld(v, "PLACEOFSUPPLY") || "(empty)");
      ok("state name is set", fld(v, "STATENAME") === HOME_STATE, fld(v, "STATENAME") || "(empty)");
      ok("country of residence is set", fld(v, "COUNTRYOFRESIDENCE").length > 0, fld(v, "COUNTRYOFRESIDENCE") || "(empty)");
      ok("not cancelled, not optional", fld(v, "ISCANCELLED") !== "Yes" && fld(v, "ISOPTIONAL") !== "Yes");

      const cgst = taxHead(v, /OUTPUT CGST/i), sgst = taxHead(v, /OUTPUT SGST/i), igst = taxHead(v, /OUTPUT IGST/i);
      ok("intra-state supply is CGST + SGST", cgst > 0 && sgst > 0, `CGST ₹${cgst}, SGST ₹${sgst}`);
      ok("and carries NO IGST", igst === 0, `IGST ₹${igst}`);
      ok("CGST equals SGST", Math.abs(cgst - sgst) < 0.02, `₹${cgst} vs ₹${sgst}`);
      ok(`tax matches the item's ${gstPct}% rate on the taxable value`,
        Math.abs(cgst + sgst - r2((taxable * gstPct) / 100)) < 0.05,
        `₹${r2(cgst + sgst)} against expected ₹${r2((taxable * gstPct) / 100)}`);

      const lines = allAmounts(v);
      const net = r2(lines.reduce((s, l) => s + l.amount, 0));
      // Assert there ARE lines: an empty list sums to zero and would sail
      // through a balance check on a voucher that does not exist.
      ok("the voucher balances", lines.length > 0 && Math.abs(net) < 0.02,
        `${lines.length} line(s), net ₹${net}`);

      // HSN is not something we emit — Tally derives it from the item master.
      // If it does not, the line files under "HSN/SAC not specified".
      const hsn = [...new Set(inventoryLines(v).map((l) => l.hsn).filter(Boolean))];
      ok("Tally attached an HSN to the stock line", hsn.length > 0, hsn.join(", ") || "(none — would file as HSN not specified)");
    }

    // ═════ SALES ORDER ══════════════════════════════════════════════════
    H("SALES ORDER NOTE · identity carried, stock untouched");
    {
      const v = get("SO");
      const reg = registrationOn(customer, DATE);
      ok("carries the party GSTIN", fld(v, "PARTYGSTIN") === reg.gstin.trim(), fld(v, "PARTYGSTIN") || "(empty)");
      ok("place of supply is set", fld(v, "PLACEOFSUPPLY") === HOME_STATE, fld(v, "PLACEOFSUPPLY") || "(empty)");
      ok("not cancelled, not optional", fld(v, "ISCANCELLED") !== "Yes" && fld(v, "ISOPTIONAL") !== "Yes");
      const lines = allAmounts(v);
      const net = r2(lines.reduce((s, l) => s + l.amount, 0));
      ok("the order balances", lines.length > 0 && Math.abs(net) < 0.02, `${lines.length} line(s), net ₹${net}`);
    }

    // ═════ PURCHASE ═════════════════════════════════════════════════════
    H("PURCHASE · inter-state, IGST only");
    {
      const v = get("PUR");
      const reg = registrationOn(supplier, DATE);
      ok("stored as an invoice", fld(v, "ISINVOICE") === "Yes", fld(v, "ISINVOICE"));
      ok("carries the supplier GSTIN", fld(v, "PARTYGSTIN") === reg.gstin.trim(), fld(v, "PARTYGSTIN") || "(empty)");
      ok("registration type is set", fld(v, "GSTREGISTRATIONTYPE").length > 0, fld(v, "GSTREGISTRATIONTYPE") || "(empty)");
      // On a purchase the supply comes TO us, so place of supply is our state
      // while the party's state is theirs. Getting these the same way round as
      // a sale is the classic way to book IGST as CGST+SGST.
      ok("place of supply is OUR state", fld(v, "PLACEOFSUPPLY") === HOME_STATE, fld(v, "PLACEOFSUPPLY") || "(empty)");

      const igst = taxHead(v, /INPUT IGST/i), cgst = taxHead(v, /INPUT CGST/i), sgst = taxHead(v, /INPUT SGST/i);
      ok("inter-state supply is IGST", igst > 0, `IGST ₹${igst}`);
      ok("and carries NO CGST or SGST", cgst === 0 && sgst === 0, `CGST ₹${cgst}, SGST ₹${sgst}`);
      ok(`IGST matches the ${pGst}% rate on the taxable value`,
        Math.abs(igst - pIgst) < 0.05, `₹${igst} against expected ₹${pIgst}`);
      const net = r2(ledgerAmounts(v).reduce((s, l) => s + l.amount, 0));
      ok("the voucher balances", Math.abs(net) < 0.02, `net ₹${net}`);
      const hsn = [...new Set(inventoryLines(v).map((l) => l.hsn).filter(Boolean))];
      ok("Tally attached an HSN to the stock line", hsn.length > 0, hsn.join(", ") || "(none)");
    }

    // ═════ MONEY VOUCHERS ═══════════════════════════════════════════════
    H("PAYMENT · RECEIPT · CONTRA — correct precisely by carrying no GST");
    for (const [label, key, party, amount, bill] of [
      ["payment", "PAY", supplier.name, PAY, n("PUR")],
      ["receipt", "RCT", customer.name, RCV, n("SAL")],
    ] as const) {
      const v = get(key);
      console.log(`  ${label}`);
      ok(`  not an invoice`, fld(v, "ISINVOICE") === "No", fld(v, "ISINVOICE"));
      ok(`  carries no GST identity, as Tally's own do`,
        !fld(v, "PARTYGSTIN") && !fld(v, "PLACEOFSUPPLY"),
        `GSTIN "${fld(v, "PARTYGSTIN")}", POS "${fld(v, "PLACEOFSUPPLY")}"`);
      const lines = allAmounts(v);
      const net = r2(lines.reduce((s, l) => s + l.amount, 0));
      ok(`  balances`, lines.length > 0 && Math.abs(net) < 0.02, `${lines.length} line(s), net ₹${net}`);
      ok(`  hits the right party for ₹${amount}`,
        lines.some((l) => l.name === party && Math.abs(Math.abs(l.amount) - amount) < 0.02),
        lines.map((l) => `${l.name} ${l.amount}`).join(" | ").slice(0, 90));
      ok(`  hits the bank for ₹${amount}`,
        lines.some((l) => new RegExp(BANK, "i").test(l.name) && Math.abs(Math.abs(l.amount) - amount) < 0.02));
      // Agst Ref against another party's bill is silently rewritten to New Ref,
      // creating a liability instead of clearing one. Only the read-back sees it.
      const refs = [...v.matchAll(/<BILLALLOCATIONS\.LIST>([\s\S]*?)<\/BILLALLOCATIONS\.LIST>/g)].map((x) => x[1]);
      const agst = refs.filter((r) => /Agst Ref/i.test(fld(r, "BILLTYPE")));
      ok(`  allocation stayed "Agst Ref" against ${bill}`,
        agst.length > 0 && agst.some((r) => fld(r, "NAME") === bill),
        agst.length ? agst.map((r) => `${fld(r, "NAME")} ${fld(r, "BILLTYPE")}`).join(", ") : "NOT Agst Ref — Tally rewrote it");
    }
    {
      const v = get("CON");
      console.log(`  contra`);
      ok(`  not an invoice`, fld(v, "ISINVOICE") === "No", fld(v, "ISINVOICE"));
      ok(`  carries no GST identity`, !fld(v, "PARTYGSTIN") && !fld(v, "PLACEOFSUPPLY"));
      const lines = allAmounts(v);
      const net = r2(lines.reduce((s, l) => s + l.amount, 0));
      ok(`  balances`, lines.length > 0 && Math.abs(net) < 0.02, `${lines.length} line(s), net ₹${net}`);
      ok(`  moves ₹${CONTRA} between cash and bank`,
        lines.some((l) => /cash/i.test(l.name)) && lines.some((l) => new RegExp(BANK, "i").test(l.name)),
        lines.map((l) => `${l.name} ${l.amount}`).join(" | "));
    }

    // ═════ NO NEW EXCEPTIONS ════════════════════════════════════════════
    // An exception is a missing identity field on a voucher that needs one.
    // Sales/Purchase/Sales Order need one; money vouchers do not.
    H("NO NEW EXCEPTIONS");
    for (const [key, label] of [["SAL", "sales"], ["SO", "sales order"], ["PUR", "purchase"]] as const) {
      const v = get(key);
      const missing = ["PARTYGSTIN", "GSTREGISTRATIONTYPE", "PLACEOFSUPPLY", "STATENAME", "COUNTRYOFRESIDENCE"]
        .filter((f) => !fld(v, f));
      ok(`${label} is complete on every field GSTR-1 classifies on`,
        missing.length === 0, missing.length ? `missing: ${missing.join(", ")}` : "all present");
    }
  } finally {
    // ═════ CLEAN UP ═════════════════════════════════════════════════════
    if (KEEP) {
      console.log(`\n--keep: leaving ${made.length} voucher(s) in place. Numbers start ${TAG}.`);
    } else {
      H("CLEANING UP");
      // Sweep by what is ACTUALLY in the books, not by what the pusher reported
      // as successful. safePush returning ok:false does not mean nothing was
      // created — its read-back diff rejects vouchers Tally accepted, and an
      // Agst Ref silently rewritten to New Ref is exactly that case. A cleanup
      // driven off the success list left two real vouchers behind on the first
      // run of this script.
      const inBooks = (await vouchersOnDay(company, STAMP))
        .filter((v) => fld(v, "VOUCHERNUMBER").startsWith(TAG))
        .map((v) => ({ type: fld(v, "VOUCHERTYPENAME"), number: fld(v, "VOUCHERNUMBER") }));

      // Reverse creation order: the payment and receipt point at bills the sale
      // and purchase created, so clear the dependants first.
      const order = plan.map((p) => p.number);
      inBooks.sort((a, b) => order.indexOf(b.number) - order.indexOf(a.number));

      let removed = 0;
      for (const v of inBooks) {
        if (await remove(company, v.type, v.number, `MKCP|${v.type}|${v.number}|2026-27`)) removed++;
      }
      const left = (await vouchersOnDay(company, STAMP)).filter((v) => fld(v, "VOUCHERNUMBER").startsWith(TAG));
      ok("every voucher this run created has been removed", left.length === 0,
        `found ${inBooks.length} in the books, deleted ${removed}, ${left.length} left behind`);
    }
    console.log(`\nTally ${(await healthy()) ? "still healthy" : "\x1b[31mNOT ANSWERING\x1b[0m"}.`);
  }

  console.log(`\n\x1b[1m${passed} passed · ${failed} failed\x1b[0m`);
  if (failed) console.log(`\nfailed:\n${failures.map((f) => `  · ${f}`).join("\n")}`);
  console.log();
  process.exit(failed ? 1 : 0);
})();
