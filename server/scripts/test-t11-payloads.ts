/**
 * Offline proof of the T11 rigs' payloads (no Tally, no Supabase, no network).
 *
 * Before a rig may touch the dummy, every voucher it will send is shown to be:
 *   - accepted by the push guard on masters shaped like the dummy's (fixture masters plus the rig's ZZ TEST ones),
 *   - a well-formed Import envelope that balances (the builder throws on an imbalance),
 *   - in a spelling the sweep and the census know (ZZTEST<digits>/<tag>, REMOTEID guessable, narration marked),
 *   - fake (ZZ TEST names, ZZZ GSTINs with a valid check digit, no real name anywhere),
 *   - carrying the lines the scenario is about (discount and freight appropriated to GST, buyer on a cash bill, ...).
 * And that the field-by-field comparer (rigs/lib/t11Check.ts) reads a voucher it is given: it passes the voucher
 * our own builder writes, and it names a dropped narration, a wrong side, a missing appropriation and a lost bill.
 *
 *   npx tsx scripts/test-t11-payloads.ts
 */
import { buildVoucherImportXml } from "../src/services/voucherPusher.js";
import { guardVoucher } from "../src/services/pushGuard.js";
import { isGstinChecksumValid } from "../src/services/gstIdentity.js";
import type { TallyMasters, MasterLedger, MasterItem } from "../src/services/tallyMasters.js";
import type { VoucherPayload } from "../src/types.js";
import { fixtureMasters, fixtureOpenBills, OPEN_DATE, G_PARTS } from "./guardrails/fixtures.js";
import { isSweepVoucher } from "./lib/testVoucherMatch.js";
import { remoteIdGuesses } from "./find-stranded-test-vouchers.js";
import { DUMMY_KIT, r2, saleTotals, zzItems, zzParties, fakeGstin } from "./rigs/lib/t11Kit.js";
import { c23, c25, c26, c26b, c29 } from "./rigs/lib/t11Scenarios.js";
import { compareToPayload, failures } from "./rigs/lib/t11Check.js";
import { stockJournalScenario } from "./rigs/lib/t11StockJournal.js";
import { buildStockJournalXml } from "../src/services/stockJournal.js";
import { moneyParties, moneyScenario, alteredCopy } from "./rigs/lib/t11Money.js";
import { ledgerFlagsXml } from "./rigs/lib/t11Live.js";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}${detail ? `  — ${detail}` : ""}`); }
};

const STAMP = "123456";
const DAY = OPEN_DATE;
const kit = DUMMY_KIT;

// ── Masters: the fixtures, plus the books the rigs use, plus the rig's own ZZ TEST ones ─────────────────────
function mastersWithZz(): TallyMasters {
  const m = fixtureMasters();
  const ledgers = new Map(m.ledgers);
  const items = new Map(m.items);
  const mk = (name: string, parent: string, o: Partial<MasterLedger> = {}): MasterLedger =>
    ({ name, parent, gstin: "", state: "", pincode: "", mailingName: "", address: [], registrations: [], ...o } as MasterLedger);
  for (const n of [kit.freightRcm]) ledgers.set(n, mk(n, "Direct Expenses"));
  ledgers.set(kit.rcmAsset, mk(kit.rcmAsset, "Current Assets"));
  ledgers.set(kit.bank, mk(kit.bank, "Bank Accounts"));
  ledgers.set("ZZ BANK TWO", mk("ZZ BANK TWO", "Bank Accounts"));
  ledgers.set("TDS PAYABLE ZZ", mk("TDS PAYABLE ZZ", "Duties & Taxes"));
  const z = zzParties(STAMP);
  for (const p of [...Object.values(z), ...Object.values(moneyParties(STAMP))]) {
    ledgers.set(p.name, mk(p.name, p.parent, {
      gstin: p.gstin, state: p.state, pincode: p.pincode, mailingName: p.name, address: p.address,
      registrations: [{ applicableFrom: "20260401", gstin: p.gstin, registrationType: p.gstRegistrationType, placeOfSupply: p.state, state: p.state } as never],
    }));
  }
  for (const it of zzItems(STAMP, kit)) {
    items.set(it.name, { name: it.name, parent: it.parent, baseUnit: it.baseUnit, denominator: 1, closingRate: 0, closingStock: 0,
      gstRate: it.gstRate, cgstRate: it.gstRate / 2, sgstRate: it.gstRate / 2, igstRate: it.gstRate,
      gstRevisions: [{ from: "2026-04-01", rate: it.gstRate, cgst: it.gstRate / 2, sgst: it.gstRate / 2, igst: it.gstRate, taxability: "Taxable" }],
      gstRateSource: "Specify Details Here" } as unknown as MasterItem);
  }
  // The stock group is the fixtures' own (it declares the HSN).
  void G_PARTS;
  return { ...m, ledgers, items, ledgerLoose: new Map([...ledgers.keys()].map((k) => [k.replace(/\s+/g, " ").trim().toUpperCase(), k])), itemLoose: new Map([...items.keys()].map((k) => [k.replace(/\s+/g, " ").trim().toUpperCase(), k])),
    voucherTypes: new Set([...m.voucherTypes, "Stock Journal"]) } as TallyMasters;
}
const M = mastersWithZz();

function wellFormed(xml: string): string | null {
  const stack: string[] = [];
  const re = /<(\/?)([A-Za-z0-9_.:]+)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const [, close, tag, , self] = m;
    if (self) continue;
    if (close) { const open = stack.pop(); if (open !== tag) return `</${tag}> closes <${open ?? "nothing"}>`; } else stack.push(tag);
  }
  if (stack.length) return `unclosed <${stack[stack.length - 1]}>`;
  const bad = /&(?!amp;|lt;|gt;|quot;|apos;|#\d+;)/.exec(xml);
  return bad ? `unescaped & at ${bad.index}` : null;
}

/** The standard battery for one payload that the guard must accept. */
function accepted(label: string, p: VoucherPayload, ctx: Parameters<typeof guardVoucher>[2] = {}) {
  const g = guardVoucher(p, M, ctx);
  ok(`${label}: the guard accepts it`, g.ok, g.errors.join(" | ").slice(0, 400));
  let xml = "";
  try { xml = buildVoucherImportXml(M.company, p, M); ok(`${label}: builds and balances`, true); }
  catch (e) { ok(`${label}: builds and balances`, false, (e as Error).message); return; }
  ok(`${label}: well-formed XML`, wellFormed(xml) === null, wellFormed(xml) ?? "");
  ok(`${label}: carries a ZZTEST number, mark in the narration`, isSweepVoucher({ number: p.voucherNumber ?? "", narration: p.narration ?? "" }, "ZZTEST"));
  const guesses = remoteIdGuesses(p.voucherType.toUpperCase(), p.voucherNumber ?? "");
  ok(`${label}: its REMOTEID is a spelling the sweep guesses (or the rig deletes it by its own)`,
    guesses.includes(p.remoteId ?? "") || /^MKCP\|[A-Z ]+\|ZZTEST\d+\//.test(p.remoteId ?? ""), p.remoteId);
}

// ── The fake identity ───────────────────────────────────────────────────────
console.log("Fake data:");
const z = zzParties(STAMP);
ok("every fake party name starts ZZ TEST", Object.values(z).every((p) => p.name.startsWith("ZZ TEST ")));
ok("every fake GSTIN is ZZZ-series with a valid check digit", Object.values(z).filter((p) => p.gstin).every((p) => /^\d\dZZZ/.test(p.gstin) && isGstinChecksumValid(p.gstin)), Object.values(z).map((p) => p.gstin).join(","));
ok("fake GSTINs differ party to party", new Set(Object.values(z).map((p) => p.gstin).filter(Boolean)).size === 3);
ok("fakeGstin is stable for the same serial", fakeGstin("19", 7) === fakeGstin("19", 7));
ok("every fake item name starts ZZ TEST", zzItems(STAMP, kit).every((i) => i.name.startsWith("ZZ TEST ")));

// ── C23 ──────────────────────────────────────────────────────────────────────
console.log("\nC23 purchase with items Tally lacks:");
{
  const s = c23(STAMP, DAY, kit);
  accepted("purchase of the new items", s.purchase);
  // Before the items exist the guard must refuse and say so.
  const noItems = { ...M, items: new Map([...M.items].filter(([k]) => !k.startsWith("ZZ TEST ITEM"))) } as TallyMasters;
  const r = guardVoucher(s.beforeItems, noItems, {});
  ok("C23 the same purchase is refused while the items are missing", !r.ok && r.errors.some((e) => /does not exist/i.test(e)), r.errors.join(" | ").slice(0, 200));
  ok("C23 purchase is interstate IGST from a Punjab supplier", s.purchase.ledgerEntries.some((e) => e.ledgerName === kit.inIgst) && !s.purchase.ledgerEntries.some((e) => e.ledgerName === kit.inCgst));
  ok("C23 the supplier's bill is the New Ref and the reference", s.purchase.ledgerEntries[0].billAllocations?.[0].name === s.purchase.reference && s.purchase.reference!.startsWith("ZZB"));
  ok("C23 no place of supply declared on an inward voucher", s.purchase.placeOfSupply === undefined);
}

// ── C25 ──────────────────────────────────────────────────────────────────────
console.log("\nC25 truck run of 4 notes converted after Process:");
{
  const s = c25(STAMP, DAY, kit);
  ok("C25 four notes", s.notes.length === 4);
  for (const t of s.notes) {
    const n = s.noteOf(t), inv = s.invoiceOf(t);
    accepted(`C25 note ${t.tag}`, n);
    accepted(`C25 invoice ${t.tag}`, inv);
    ok(`C25 ${t.tag}: the invoice is the note's voucher (same REMOTEID and number)`, n.remoteId === inv.remoteId && n.voucherNumber === inv.voucherNumber && inv.action === "Alter");
    ok(`C25 ${t.tag}: the note is not an invoice, the invoice is`, n.isInvoice === false && inv.isInvoice === true && inv.voucherType === "Sales" && n.voucherType === "Sales Order Note");
    const adj = inv.ledgerEntries.filter((e) => e.ledgerName === kit.discount);
    const net = r2(t.freight - t.discount);
    if (net === 0) ok(`C25 ${t.tag}: no adjustment line when nothing nets`, adj.length === 0);
    else {
      ok(`C25 ${t.tag}: one TRADE DISCOUNTS / H.C. line, ${net < 0 ? "a negative credit" : "a positive credit"}, appropriated to GST`,
        adj.length === 1 && adj[0].isDeemedPositive === false && adj[0].signedAmount === net && adj[0].appropriateToGst === "Goods");
      const xml = buildVoucherImportXml(M.company, inv, M);
      ok(`C25 ${t.tag}: the XML says APPROPRIATEFOR GST on that line`, /<APPROPRIATEFOR>GST<\/APPROPRIATEFOR>/.test(xml));
    }
    ok(`C25 ${t.tag}: the note carries no adjustment (it only reserves)`, !n.ledgerEntries.some((e) => e.ledgerName === kit.discount));
    ok(`C25 ${t.tag}: ${t.inter ? "IGST only" : "CGST and SGST equal"}`, t.inter
      ? inv.ledgerEntries.some((e) => e.ledgerName === kit.outIgst) && !inv.ledgerEntries.some((e) => e.ledgerName === kit.outCgst)
      : inv.ledgerEntries.find((e) => e.ledgerName === kit.outCgst)?.amount === inv.ledgerEntries.find((e) => e.ledgerName === kit.outSgst)?.amount);
  }
  ok("C25 both signs of net adjustment are covered", s.notes.some((t) => t.freight - t.discount < 0) && s.notes.some((t) => t.freight - t.discount > 0));
  ok("C25 a freight-only and a discount-only note are covered", s.notes.some((t) => t.discount === 0 && t.freight > 0) && s.notes.some((t) => t.freight === 0 && t.discount > 0));
}

// ── C26 ──────────────────────────────────────────────────────────────────────
console.log("\nC26 one note split into cash bills and a ledger bill:");
{
  const s = c26(STAMP, DAY, kit);
  accepted("C26 the note", s.note);
  accepted("C26 the ledger bill (the note, altered)", s.ledgerBill);
  s.cashBills.forEach((b, i) => accepted(`C26 cash bill ${i + 1}`, b));
  const bills = [s.ledgerBill, ...s.cashBills];
  const tot = bills.map(saleTotals);
  ok("C26 the bills' taxable values add back to the note exactly", r2(tot.reduce((a, t) => a + t.taxable, 0)) === s.whole.taxable, `${tot.map((t) => t.taxable)} vs ${s.whole.taxable}`);
  ok("C26 the bills' tax adds back to the note's, within 2 paise", Math.abs(r2(tot.reduce((a, t) => a + t.tax, 0)) - s.whole.tax) <= 0.02, `${tot.map((t) => t.tax)} vs ${s.whole.tax}`);
  ok("C26 each bill's party line is its taxable + tax + round-off to the paisa", tot.every((t) => Math.abs(r2(t.taxable + t.tax + t.roundOff) - t.grand) < 0.005), JSON.stringify(tot));
  ok("C26 each cash bill is on the shared Cash ledger with a typed buyer name and address", s.cashBills.every((b) => b.partyLedgerName === kit.cash && !!b.buyerName && (b.buyerAddress?.length ?? 0) >= 1));
  ok("C26 each cash bill is under the Rs 50,000 limit", s.cashBills.every((b) => saleTotals(b).taxable < 50000));
  ok("C26 the ledger bill is the note's voucher", s.ledgerBill.remoteId === s.note.remoteId && s.ledgerBill.action === "Alter");
  ok("C26 every bill has its own REMOTEID", new Set(bills.map((b) => b.remoteId)).size === 3);
  ok("C26 a cash bill carries no bill allocation", s.cashBills.every((b) => !b.ledgerEntries[0].billAllocations));
}

console.log("\nC26b the split's edges:");
{
  const s = c26b(STAMP, DAY, kit);
  const over = guardVoucher(s.overLimit, M, {});
  ok("C26b a cash bill over Rs 50,000 is refused", !over.ok && over.errors.some((e) => /50,?000/.test(e)), over.errors.join(" | ").slice(0, 200));
  const nb = guardVoucher(s.noBuyer, M, {});
  ok("C26b a cash bill with no buyer name is refused", !nb.ok && nb.errors.some((e) => /buyer/i.test(e)), nb.errors.join(" | ").slice(0, 200));
  const ws = guardVoucher(s.wrongState, M, {});
  ok("C26b a cash bill taxed as interstate is refused", !ws.ok, ws.errors.join(" | ").slice(0, 200));
  accepted("C26b share A (6 of 10)", s.shareA);
  accepted("C26b share B (4 of 10)", s.shareB);
  const ta = saleTotals(s.shareA), tb = saleTotals(s.shareB);
  ok("C26b the two shares' taxable values add to the whole line", r2(ta.taxable + tb.taxable) === s.wholeLine.taxable, `${ta.taxable}+${tb.taxable} vs ${s.wholeLine.taxable}`);
  ok("C26b the two shares' tax adds to the whole line's within 2 paise", Math.abs(r2(ta.tax + tb.tax) - s.wholeLine.tax) <= 0.02, `${ta.tax}+${tb.tax} vs ${s.wholeLine.tax}`);
}

// ── C29 ──────────────────────────────────────────────────────────────────────
console.log("\nC29 freight bill under reverse charge:");
{
  const s = c29(STAMP, DAY, kit);
  accepted("C29 the freight bill", s.bill);
  accepted("C29 the RCM increase-in-liability journal", s.tax);
  accepted("C29 the RCM decrease-in-liability journal", s.taxDecrease);
  const open = [...fixtureOpenBills(), { name: s.billNo, party: s.parties.transport.name, date: DAY.replace(/-/g, ""), closing: s.amount, outstanding: s.amount, creditPeriod: "" }];
  accepted("C29 the payment of the bill (Agst Ref)", s.pay, { openBills: open });
  ok("C29 the bill has no GST line and no stock (the tax is booked by the journal)", s.bill.ledgerEntries.length === 2 && !s.bill.inventoryEntries?.length);
  ok("C29 Cr carrier with a New Ref named by his bill, Dr FREIGHT ( UNDER RCM ) for the net",
    s.bill.ledgerEntries[0].isDeemedPositive === false && s.bill.ledgerEntries[0].billAllocations?.[0].billType === "New Ref"
    && s.bill.ledgerEntries[1].ledgerName === kit.freightRcm && s.bill.ledgerEntries[1].isDeemedPositive === true);
  const bal = (j: VoucherPayload) => { const t = (dr: boolean) => r2(j.ledgerEntries.filter((e) => e.isDeemedPositive === dr).reduce((x, e) => x + e.amount, 0)); return [t(true), t(false)]; };
  const [i1, i2] = bal(s.tax), [d1, d2] = bal(s.taxDecrease);
  ok("C29 each journal balances; the increase books 5 percent of the bill as OUTPUT tax", i1 === i2 && d1 === d2 && i1 === s.rcmTax && s.rcmTax === 2075, `${i1}/${i2} ${d1}/${d2}`);
  ok("C29 the increase is Dr GST UNDER RCM, Cr OUTPUT CGST and SGST; the decrease is Dr INPUT CGST and SGST, Cr GST UNDER RCM",
    s.tax.ledgerEntries[0].ledgerName === kit.rcmAsset && s.tax.ledgerEntries[0].isDeemedPositive && s.tax.ledgerEntries.slice(1).every((e) => /^OUTPUT [CS]GST$/.test(e.ledgerName) && !e.isDeemedPositive)
    && s.taxDecrease.ledgerEntries.slice(0, 2).every((e) => /^INPUT [CS]GST$/.test(e.ledgerName) && e.isDeemedPositive) && s.taxDecrease.ledgerEntries[2].ledgerName === kit.rcmAsset && !s.taxDecrease.ledgerEntries[2].isDeemedPositive);
  ok("C29 the party of each journal is its first debit ledger (the Journal convention)", s.tax.partyLedgerName === kit.rcmAsset && s.taxDecrease.partyLedgerName === kit.inCgst);
  ok("C29 the payment settles the bill against its Agst Ref", s.pay.ledgerEntries[0].billAllocations?.[0].billType === "Agst Ref" && s.pay.ledgerEntries[0].billAllocations?.[0].name === s.billNo);
}

// ── C29 tax-adjustment flag (D-M.180): the XML, the guard and the comparer ───
console.log("\nC29 reverse-charge journals carry the tax-adjustment flag:");
{
  const s = c29(STAMP, DAY, kit);
  const ix = buildVoucherImportXml(M.company, s.tax, M);
  const dx = buildVoucherImportXml(M.company, s.taxDecrease, M);
  ok("the increase journal sends TAXADJUSTMENT Increase, STATPAYMENTTYPE GST and GSTADDITIONALDETAILS Others",
    /<TAXADJUSTMENT>Increase in Tax Liability<\/TAXADJUSTMENT>/.test(ix) && /<STATPAYMENTTYPE>GST<\/STATPAYMENTTYPE>/.test(ix) && /<GSTADDITIONALDETAILS>Others<\/GSTADDITIONALDETAILS>/.test(ix));
  ok("the decrease journal sends TAXADJUSTMENT Decrease", /<TAXADJUSTMENT>Decrease in Tax Liability<\/TAXADJUSTMENT>/.test(dx) && !/Increase in Tax/.test(dx));
  ok("the tax lines send the half rate (2.50 on a 5 percent bill) and the taxable value; the holding line neither",
    (ix.match(/<GSTTAXRATE>2\.50<\/GSTTAXRATE>/g) ?? []).length === 2 && (ix.match(/<GSTASSESSABLEVALUE>/g) ?? []).length === 2 && (dx.match(/<GSTTAXRATE>2\.50<\/GSTTAXRATE>/g) ?? []).length === 2);
  ok("the assessable value is the freight taxable amount", new RegExp(`<GSTASSESSABLEVALUE>${s.amount.toFixed(2)}</GSTASSESSABLEVALUE>`).test(ix), ix.match(/<GSTASSESSABLEVALUE>[^<]*/)?.[0]);
  ok("every line of an adjustment journal mirrors its amount in VATEXPAMOUNT, as the hand-typed ones do", (ix.match(/<VATEXPAMOUNT>/g) ?? []).length === 3);
  const plain = { ...s.tax, taxAdjustment: undefined, ledgerEntries: s.tax.ledgerEntries.map((e) => ({ ...e, gstTaxRate: undefined, gstAssessableValue: undefined })) } as VoucherPayload;
  const px = buildVoucherImportXml(M.company, plain, M);
  ok("a journal with no adjustment sends none of these tags (nothing else changed)", !/TAXADJUSTMENT|STATPAYMENTTYPE|GSTADDITIONALDETAILS|GSTTAXRATE|GSTASSESSABLEVALUE|VATEXPAMOUNT/.test(px));
  const onSales = { ...s.bill, taxAdjustment: "Increase in Tax Liability" } as VoucherPayload;
  ok("a tax adjustment on a Purchase is refused", !guardVoucher(onSales, M, {}).ok);
  const bad = { ...s.tax, taxAdjustment: "Whatever" } as unknown as VoucherPayload;
  ok("an unknown adjustment is refused", !guardVoucher(bad, M, {}).ok);
  const rateNoAdj = { ...plain, ledgerEntries: plain.ledgerEntries.map((e, i) => (i === 1 ? { ...e, gstTaxRate: 2.5, gstAssessableValue: 100 } : e)) } as VoucherPayload;
  ok("a GST rate on a voucher with no adjustment is refused", !guardVoucher(rateNoAdj, M, {}).ok);
  const rateOnly = { ...s.tax, ledgerEntries: s.tax.ledgerEntries.map((e, i) => (i === 1 ? { ...e, gstAssessableValue: undefined } : e)) } as VoucherPayload;
  ok("a rate without the assessable value is refused", !guardVoucher(rateOnly, M, {}).ok);
  const zeroRate = { ...s.tax, ledgerEntries: s.tax.ledgerEntries.map((e, i) => (i === 1 ? { ...e, gstTaxRate: 0 } : e)) } as VoucherPayload;
  ok("a zero GST rate is refused", !guardVoucher(zeroRate, M, {}).ok);
  // The comparer reads the flag back: it passes our own XML, and names a dropped flag and a wrong rate.
  const rd = compareToPayload(s.tax, ix.replace(/^[\s\S]*?<VOUCHER /, "<VOUCHER "));
  ok("the comparer checks the flag, the payment type, the details and each rate and value",
    ["tax adjustment", "statutory payment type", "GST additional details"].every((f) => rd.some((r) => r.field === f && r.ok)) && rd.filter((r) => /GST rate|assessable value/.test(r.field) && r.ok).length === 4,
    failures(rd).join(" | "));
  const dropped = compareToPayload(s.tax, ix.replace(/^[\s\S]*?<VOUCHER /, "<VOUCHER ").replace(/<TAXADJUSTMENT>[^<]*<\/TAXADJUSTMENT>/, ""));
  ok("the comparer names a dropped flag", failures(dropped).some((r) => /tax adjustment/.test(r)));
  const wrongRate = compareToPayload(s.tax, ix.replace(/^[\s\S]*?<VOUCHER /, "<VOUCHER ").replace(/<GSTTAXRATE>2\.50/, "<GSTTAXRATE>6.00"));
  ok("the comparer names a wrong rate", failures(wrongRate).some((r) => /GST rate/.test(r)));
}

// ── C22: Stock Journal ───────────────────────────────────────────────────────
console.log("\nC22 Stock Journal from a count difference:");
{
  const s = stockJournalScenario(STAMP, DAY, kit);
  accepted("C22 stock in (count above the books)", s.gain);
  accepted("C22 stock out (count below the books)", s.loss);
  const gx = buildVoucherImportXml(M.company, s.gain, M);
  const lx = buildVoucherImportXml(M.company, s.loss, M);
  ok("C22 a Stock Journal is not an invoice and carries no ledger lines", s.gain.isInvoice === false && s.gain.ledgerEntries.length === 0);
  ok("C22 the gain is built as stock IN, the loss as stock OUT", /INVENTORYENTRIESIN\.LIST/.test(gx) && !/INVENTORYENTRIESOUT\.LIST/.test(gx) && /INVENTORYENTRIESOUT\.LIST/.test(lx) && !/INVENTORYENTRIESIN\.LIST/.test(lx));
  ok("C22 carries the REMOTEID and the narration", /REMOTEID="MKCP\|STOCK JOURNAL\|ZZTEST/.test(gx) && /<NARRATION>ZZTEST/.test(gx));
  ok("C22 the standalone builder gives the same XML as the voucher path", buildStockJournalXml(M.company, s.gain) === gx);
  ok("C22 every line has a godown and a positive quantity and amount", [...s.gain.inventoryEntries!, ...s.loss.inventoryEntries!].every((i) => i.godownName && i.quantity > 0 && i.amount > 0));
  ok("C22 the house rule: an adjustment is never worth zero", [...s.gain.inventoryEntries!, ...s.loss.inventoryEntries!].every((i) => i.amount >= 1));
  const zero = { ...s.gain, inventoryEntries: [{ ...s.gain.inventoryEntries![0], amount: 0, rate: 0 }] } as VoucherPayload;
  ok("C22 a zero-value line is refused", !guardVoucher(zero, M, {}).ok);
  const noGodown = { ...s.gain, inventoryEntries: [{ ...s.gain.inventoryEntries![0], godownName: "ZZ NO SUCH GODOWN" }] } as VoucherPayload;
  ok("C22 a godown that does not exist is refused", !guardVoucher(noGodown, M, {}).ok);
  const noRid = { ...s.gain, remoteId: undefined } as VoucherPayload;
  ok("C22 a Stock Journal with no REMOTEID is refused", !guardVoucher(noRid, M, {}).ok);
  const empty = { ...s.gain, inventoryEntries: [] } as VoucherPayload;
  ok("C22 a Stock Journal with no stock line is refused", !guardVoucher(empty, M, {}).ok);
  const both = { ...s.gain, inventoryEntries: [...s.gain.inventoryEntries!, ...s.loss.inventoryEntries!] } as VoucherPayload;
  ok("C22 one voucher may hold both directions (a transfer or a mixed count)", guardVoucher(both, M, {}).ok);
}

// ── The money matrix (D-M.164) ───────────────────────────────────────────────
console.log("\nMoney matrix: Receipt, Payment, Contra with every allocation type:");
{
  const s = moneyScenario(STAMP, DAY, kit, { tdsLedger: "TDS PAYABLE ZZ", secondBank: "ZZ BANK TWO" });
  const mp = moneyParties(STAMP);
  ok("money parties are fake and distinct; the expense and the plain debtor are NOT bill-by-bill", Object.values(mp).every((p) => p.name.startsWith("ZZ TEST ")) && mp.expense.billWise === false && mp.plainDebtor.billWise === false && mp.debtor.billWise !== false);
  const open = [
    ...fixtureOpenBills(),
    ...s.sales.map((v, i) => ({ name: v.voucherNumber!, party: mp.debtor.name, date: DAY.replace(/-/g, ""), closing: -s.g[i], outstanding: s.g[i], creditPeriod: "" })),
    ...s.freight.map((v, i) => ({ name: s.fBill(i), party: mp.carrier.name, date: DAY.replace(/-/g, ""), closing: s.freightAmounts[i], outstanding: s.freightAmounts[i], creditPeriod: "" })),
  ];
  for (const v of s.sales) accepted(`money bill ${v.voucherNumber!.split("/")[1]} (sale to the debtor)`, v);
  for (const v of s.freight) accepted(`money bill ${v.voucherNumber!.split("/")[1]} (freight bill)`, v);
  ok("14 sales bills and 8 freight bills are made first", s.sales.length === 14 && s.freight.length === 8);
  ok("the 14 sales bills have distinct amounts and numbers", new Set(s.g).size >= 10 && new Set(s.sales.map((v) => v.voucherNumber)).size === 14, s.g.join(","));
  for (const c of s.cases) {
    accepted(`money ${c.id}: ${c.label}`, c.voucher, { openBills: open });
    const sumSide = (dr: boolean) => r2(c.voucher.ledgerEntries.filter((e) => e.isDeemedPositive === dr).reduce((a, e) => a + e.amount, 0));
    ok(`money ${c.id}: debits equal credits to the paisa`, sumSide(true) === sumSide(false), `${sumSide(true)} / ${sumSide(false)}`);
    const party = c.voucher.ledgerEntries.find((e) => e.isPartyLedger);
    if (party?.billAllocations) ok(`money ${c.id}: its bill allocations add up to the party line`, r2(party.billAllocations.reduce((a, b) => a + b.amount, 0)) === party.amount);
    if (c.kind === "receipt") ok(`money ${c.id}: party credited, bank/cash debited`, c.voucher.ledgerEntries[0].isDeemedPositive === false && c.voucher.ledgerEntries[1].isDeemedPositive === true);
    if (c.kind === "payment") ok(`money ${c.id}: party debited, bank/cash credited`, c.voucher.ledgerEntries[0].isDeemedPositive === true && c.voucher.ledgerEntries[c.voucher.ledgerEntries.length - 1].isDeemedPositive === false);
    const x = buildVoucherImportXml(M.company, c.voucher, M);
    const self = failures(compareToPayload(c.voucher, x, { partyOverwritten: true }));
    ok(`money ${c.id}: the comparer finds nothing wrong on our own XML`, self.length === 0, self.join(" | ").slice(0, 300));
  }
  const ids = s.cases.map((c) => c.id);
  ok("the matrix has every allocation type: New Ref (the bills), Agst Ref, Advance, On Account (none and explicit), the 9-bill mix", ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "P3", "P4", "P5", "P7"].every((i) => ids.includes(i)));
  ok("the matrix has bank with a cheque number, with a UTR and with no instrument; cash; non-bill-wise; expense; TDS; three contras", ["R1", "R2", "R4", "R9", "R10", "P1", "P2", "P8", "P9", "K1", "K2", "K3"].every((i) => ids.includes(i)));
  const mix = s.cases.find((c) => c.id === "R8")!.voucher.ledgerEntries[0].billAllocations!;
  ok("the C27 mix is 9 Agst Ref bills plus one On Account", mix.filter((b) => b.billType === "Agst Ref").length === 9 && mix.filter((b) => b.billType === "On Account").length === 1);
  const r9 = s.cases.find((c) => c.id === "R9")!.voucher; const r1 = s.cases.find((c) => c.id === "R1")!.voucher;
  ok("R9 has no bank instrument and R1 has one with a number", !r9.ledgerEntries[1].bankAllocation && !!r1.ledgerEntries[1].bankAllocation?.instrumentNumber);
  const noTds = moneyScenario(STAMP, DAY, kit, {});
  ok("without a TDS ledger or a second bank those cases are not built (a rig reports them NOT RUN)", !noTds.cases.some((c) => c.id === "P9" || c.id === "K3"));
  // Alter / Cancel / Delete
  for (const [what, v] of [["receipt", s.lifeR], ["payment", s.lifeP], ["contra", s.lifeK]] as const) {
    accepted(`money life ${what}`, v);
    const alt = alteredCopy(v, 190, "ZZCHANGED");
    const g1 = guardVoucher(alt, M, { openBills: open });
    ok(`money life ${what}: the Alter is accepted and keeps the REMOTEID, number and date`, g1.ok && alt.remoteId === v.remoteId && alt.voucherNumber === v.voucherNumber && alt.date === v.date && alt.action === "Alter", g1.errors.join("|").slice(0, 200));
    ok(`money life ${what}: the Alter changes the amount, the instrument number and the narration`, alt.ledgerEntries.every((e) => e.amount === 190) && alt.narration !== v.narration);
    const del = buildVoucherImportXml(M.company, { ...v, action: "Delete" } as VoucherPayload, M);
    const can = buildVoucherImportXml(M.company, { ...v, action: "Cancel" } as VoucherPayload, M);
    ok(`money life ${what}: Delete and Cancel XML carry ACTION and the REMOTEID`, /ACTION="Delete"/.test(del) && /ACTION="Cancel"/.test(can) && del.includes(v.remoteId!) && can.includes(v.remoteId!));
  }
  // The ledger-flag read request
  const fx = ledgerFlagsXml("CO", "ZZ TEST X");
  ok("the ledger flag read has a header ID equal to its collection name, a Ledger type, no star, one name filter", /<ID>T11LedFlags<\/ID>/.test(fx) && /COLLECTION NAME="T11LedFlags"/.test(fx) && /<TYPE>Ledger<\/TYPE>/.test(fx) && !/\.\*|NATIVEMETHOD>\*</.test(fx) && /\$Name = /.test(fx));
}

// ── The field-by-field comparer ──────────────────────────────────────────────
console.log("\nField-by-field comparer (t11Check.ts):");
{
  const s = c25(STAMP, DAY, kit);
  const inv = s.invoiceOf(s.notes[2]);                        // discount and freight, interstate
  const xml = buildVoucherImportXml(M.company, inv, M);
  const same = compareToPayload(inv, xml);
  ok("the comparer finds nothing to complain about on the voucher our own builder writes", failures(same).length === 0, failures(same).join(" | "));
  ok("live mode also expects the sales/purchase posting line Tally derives from the stock lines (our own import XML has none, so it is named missing)", failures(compareToPayload(inv, xml, { derivedPostings: true })).some((f) => /posting ledger/.test(f)));
  ok("it checks many fields (date, type, number, narration, lines, sides, bills, stock, godown, batch, accounting)", same.length >= 40, `${same.length} checks`);
  const bad = (re: RegExp, to: string) => failures(compareToPayload(inv, xml.replace(re, to)));
  ok("it names a narration Tally dropped", bad(/<NARRATION>[^<]*<\/NARRATION>/, "").some((f) => /^narration/.test(f)));
  ok("it names a changed date", bad(/<DATE>\d+<\/DATE>/, "<DATE>20200101</DATE>").some((f) => /^date/.test(f)));
  ok("it names a lost APPROPRIATEFOR", bad(/<APPROPRIATEFOR>GST<\/APPROPRIATEFOR>/, "").some((f) => /appropriates to GST/.test(f)));
  ok("it names a dropped godown", bad(/<GODOWNNAME>[^<]*<\/GODOWNNAME>/, "<GODOWNNAME>X</GODOWNNAME>").some((f) => /godown/.test(f)));
  ok("it names a lost bill allocation", bad(/<BILLALLOCATIONS\.LIST>[\s\S]*?<\/BILLALLOCATIONS\.LIST>/, "").some((f) => /bill/.test(f)));
  ok("it names a ledger Tally discarded", bad(/<LEDGERNAME>OUTPUT IGST<\/LEDGERNAME>/g, "<LEDGERNAME>X</LEDGERNAME>").some((f) => /OUTPUT IGST/.test(f)));
  ok("it names a wrong side", bad(/<ISDEEMEDPOSITIVE>No<\/ISDEEMEDPOSITIVE>/, "<ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>").some((f) => /side/.test(f)));
  ok("it names an empty voucher as many failures", failures(compareToPayload(inv, "<VOUCHER></VOUCHER>")).length >= 10);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
