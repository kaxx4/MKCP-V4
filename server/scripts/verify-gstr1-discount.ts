/**
 * Do the two trade-discount encodings reach GSTR-1 the same way?
 *
 * `TRADE DISCOUNTS / H.C.` is on 66% of this company's sales. Tally itself
 * writes that line as ISDEEMEDPOSITIVE=No with a NEGATIVE amount — a *negative
 * credit*. Every builder in both repos could previously only produce the other
 * encoding (ISDEEMEDPOSITIVE=Yes with a negative amount, i.e. a plain debit).
 * Both balance, and Tally stores whichever it is sent without normalising.
 *
 * What is NOT established is whether the GST return treats them identically. If
 * it does not, one encoding under- or over-states taxable value on two thirds of
 * sales — which is a filing problem, not a cosmetic one.
 *
 * Method: push two invoices that are identical in every respect except the
 * discount encoding, then compare what the return reports for each. Same party,
 * same item, same quantity, same rate, same date.
 *
 *   npx tsx scripts/verify-gstr1-discount.ts --probe    # which GST reports exist
 *   npx tsx scripts/verify-gstr1-discount.ts --push     # create the pair
 *   npx tsx scripts/verify-gstr1-discount.ts --compare  # read the return back
 *   npx tsx scripts/verify-gstr1-discount.ts --cleanup  # remove the pair
 */
import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { convertCompanies } from "../src/converters/convert.js";
import { loadMasters } from "../src/services/tallyMasters.js";
import { safePush } from "../src/services/safePush.js";
import type { VoucherPayload, LedgerEntry } from "../src/types.js";

const TALLY_URL = process.env.TALLY_URL || "http://localhost:9000";
const TODAY = new Date().toISOString().slice(0, 10);
const DMY = (() => {
  const [y, m, d] = TODAY.split("-");
  return `${d}-${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][+m - 1]}-${y}`;
})();

/** Fixed numbers so the pair is stable across runs and easy to find in Tally. */
const NATIVE_NUM = "GSTCHK/NATIVE";
const DEBIT_NUM = "GSTCHK/DEBIT";
const NATIVE_ID = `MKCP|Sales|${NATIVE_NUM}|2026-27`;
const DEBIT_ID = `MKCP|Sales|${DEBIT_NUM}|2026-27`;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const strip = (s: string) => s.replace(/&#\d+;/g, "").trim();
const lead = (s: string) => { const m = /^\s*(-?[\d.]+)/.exec(String(s).replace(/,/g, "")); return m ? parseFloat(m[1]) : NaN; };
const r2 = (x: number) => Math.round(x * 100) / 100;
const inr = (n: number) => "₹" + n.toLocaleString("en-IN", { maximumFractionDigits: 2 });

async function healthy(): Promise<boolean> {
  try { return convertCompanies(await tallyPost(TALLY_URL, HEALTH_XML, 8_000)).length > 0; }
  catch { return false; }
}

async function report(company: string, id: string, dated = true): Promise<string> {
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>${id}</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY>
${dated ? `<SVFROMDATE TYPE="Date">1-Apr-2026</SVFROMDATE><SVTODATE TYPE="Date">${DMY}</SVTODATE>` : ""}
</STATICVARIABLES></DESC></BODY></ENVELOPE>`;
  return tallyPost(TALLY_URL, xml, 240_000, true);
}

/**
 * Candidate report names. An unrecognised name has been shown to come back as a
 * plain "Unknown Request" without raising a modal, so probing is safe — but each
 * is still health-checked, because a modal is what freezes the XML port.
 */
const GST_REPORTS = [
  "GSTR-1", "GSTR1", "GST R1", "Returns GSTR-1",
  "GST Returns", "GSTR-1 Summary", "HSN Summary", "GST Sales Register",
  "Sales Register", "Statutory Reports",
];

async function probe(company: string) {
  console.log("Probing for a GST return report, one at a time.\n");
  const found: string[] = [];
  for (const id of GST_REPORTS) {
    let raw = "", err = "";
    try { raw = await report(company, id); } catch (e) { err = (e as Error).message; }
    if (err) console.log(`  ✗ ${id.padEnd(22)} transport: ${err}`);
    else if (/Unknown Request|Could not find/i.test(raw)) console.log(`  ✗ ${id.padEnd(22)} not a recognised report`);
    else if (/<LINEERROR>/.test(raw)) console.log(`  ✗ ${id.padEnd(22)} ${strip(/<LINEERROR>([^<]*)/.exec(raw)![1])}`);
    else {
      const names = [...raw.matchAll(/<DSPDISPNAME>([^<]*)</g)].map(m => strip(m[1])).filter(Boolean);
      console.log(`  ✓ ${id.padEnd(22)} ${String(raw.length).padStart(8)} bytes · ${names.length} lines${names.length ? ` · ${names.slice(0, 4).join(" · ")}` : ""}`);
      found.push(id);
    }
    if (!await healthy()) { console.log(`\n⚠ Tally stopped answering after "${id}". STOPPING.`); return found; }
  }
  console.log(found.length ? `\nUsable: ${found.join(", ")}` : "\nNo GST return report is exposed over XML on this install.");
  return found;
}

/** Build one of the pair. Identical but for how the discount line is encoded. */
function invoice(opts: {
  num: string; remoteId: string; party: string; item: string; unit: string;
  rate: number; qty: number; native: boolean; godown: string;
}): VoucherPayload {
  const gross = r2(opts.qty * opts.rate);
  const disc = r2(gross * 0.10);          // a large, obvious discount
  const taxable = r2(gross - disc);
  const cgst = r2(taxable * 0.09), sgst = cgst;
  const exact = r2(taxable + cgst + sgst);
  const grand = Math.round(exact);
  const round = r2(grand - exact);

  // Both encodings now appropriate to GST, which is what makes the discount
  // reduce assessable value rather than sit beside it as an expense. Real
  // discounted invoices in this company carry it as "Goods".
  const discountLine: LedgerEntry = opts.native
    // What Tally itself writes: a negative CREDIT.
    ? { ledgerName: "TRADE DISCOUNTS / H.C.", amount: disc, isDeemedPositive: false, isPartyLedger: false, signedAmount: -disc, appropriateToGst: "Goods" }
    // What every builder could previously produce: a plain DEBIT.
    : { ledgerName: "TRADE DISCOUNTS / H.C.", amount: disc, isDeemedPositive: true, isPartyLedger: false, appropriateToGst: "Goods" };

  return {
    remoteId: opts.remoteId, voucherType: "Sales", date: TODAY, voucherNumber: opts.num,
    narration: `GST ENCODING CHECK ${opts.native ? "native negative-credit" : "debit"}`,
    partyLedgerName: opts.party, isInvoice: true,
    ledgerEntries: [
      { ledgerName: opts.party, amount: grand, isDeemedPositive: true, isPartyLedger: true,
        billAllocations: [{ name: opts.num, billType: "New Ref", amount: grand }] },
      discountLine,
      { ledgerName: "OUTPUT CGST", amount: cgst, isDeemedPositive: false, isPartyLedger: false },
      { ledgerName: "OUTPUT SGST", amount: sgst, isDeemedPositive: false, isPartyLedger: false },
      ...(round !== 0 ? [{ ledgerName: "ROUNDED OFF", amount: Math.abs(round), isDeemedPositive: round < 0, isPartyLedger: false }] : []),
    ],
    inventoryEntries: [{
      stockItemName: opts.item, quantity: opts.qty, unit: opts.unit, rate: opts.rate,
      amount: gross, isDeemedPositive: false, salesLedgerName: "SALES  ( GST W.B. )",
      godownName: opts.godown, batchName: "Primary Batch",
    }],
  };
}

async function main() {
  const company = convertCompanies(await tallyPost(TALLY_URL, HEALTH_XML, 10_000))[0]?.name;
  if (!company) throw new Error("No company loaded");
  const mode = process.argv.find(a => a.startsWith("--")) ?? "--probe";

  if (mode === "--probe") { await probe(company); return; }

  const m = await loadMasters(TALLY_URL, company);
  const party = [...m.ledgers.values()].find(l => /SUNDRY DEBTORS/i.test(l.parent) && /WEST BENGAL/i.test(l.state))!;
  const item = [...m.items.values()].find(i => i.closingStock > 40 && i.closingRate > 20)!;
  const godown = [...m.godowns][0];
  const common = { party: party.name, item: item.name, unit: item.baseUnit, rate: item.closingRate, qty: 10, godown };

  if (mode === "--cleanup") {
    for (const [num, id] of [[NATIVE_NUM, NATIVE_ID], [DEBIT_NUM, DEBIT_ID]] as const) {
      const p = invoice({ ...common, num, remoteId: id, native: true });
      const res = await safePush(TALLY_URL, company, { ...p, action: "Delete" });
      console.log(`  ${res.ok ? "✓ removed" : "✗ could not remove"} ${num}${res.ok ? "" : ` — ${res.errors[0]}`}`);
    }
    return;
  }

  if (mode === "--push") {
    console.log(`party ${party.name}\nitem  ${item.name} @ ${item.closingRate}/${item.baseUnit} × 10, 10% discount\n`);
    for (const [num, id, native] of [[NATIVE_NUM, NATIVE_ID, true], [DEBIT_NUM, DEBIT_ID, false]] as const) {
      const res = await safePush(TALLY_URL, company, invoice({ ...common, num, remoteId: id, native }));
      console.log(`  ${res.ok ? "✓" : "✗"} ${num.padEnd(16)} ${native ? "negative credit" : "plain debit  "} ${res.ok ? `id ${res.voucherId}` : (res.errors[0] ?? res.differences.join(" | "))}`);
      if (!await healthy()) { console.log("\n⚠ Tally stopped answering. STOPPING."); return; }
    }
    console.log(`\nBoth invoices are in the books, identical except the discount encoding.`);
    console.log(`Next: npx tsx scripts/verify-gstr1-discount.ts --compare`);
    return;
  }

  if (mode === "--compare") {
    // Read both vouchers back and report the figures a return is built from.
    const stamp = parseInt(TODAY.replace(/-/g, ""), 10);
    const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>GstChk</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="GstChk" ISMODIFY="No"><TYPE>Voucher</TYPE>
<NATIVEMETHOD>Date</NATIVEMETHOD><NATIVEMETHOD>VoucherNumber</NATIVEMETHOD>
<NATIVEMETHOD>VoucherTypeName</NATIVEMETHOD><NATIVEMETHOD>LedgerEntries</NATIVEMETHOD>
<NATIVEMETHOD>AllInventoryEntries</NATIVEMETHOD>
<NATIVEMETHOD>GSTRegistrationType</NATIVEMETHOD><NATIVEMETHOD>PartyGSTIN</NATIVEMETHOD>
<NATIVEMETHOD>PlaceOfSupply</NATIVEMETHOD><NATIVEMETHOD>StateName</NATIVEMETHOD>
<NATIVEMETHOD>ConsigneeGSTIN</NATIVEMETHOD><NATIVEMETHOD>PartyMailingName</NATIVEMETHOD>
<NATIVEMETHOD>PartyPinCode</NATIVEMETHOD>
<FILTER>GstChkDate</FILTER></COLLECTION>
<SYSTEM TYPE="Formulae" NAME="GstChkDate">($$YearOfDate:$Date * 10000 + $$MonthOfDate:$Date * 100 + $$DayOfDate:$Date) = ${stamp}</SYSTEM>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
    const raw: string = await tallyPost(TALLY_URL, xml, 240_000, true);
    const vs = [...raw.matchAll(/<VOUCHER\b[^>]*>[\s\S]*?<\/VOUCHER>/g)].map(x => x[0]);
    const fld = (b: string, t: string) => { const mm = new RegExp(`<${t}[^>]*>([^<]*)</${t}>`).exec(b); return mm ? strip(mm[1]) : ""; };

    for (const num of [NATIVE_NUM, DEBIT_NUM]) {
      const v = vs.find(x => fld(x, "VOUCHERNUMBER") === num);
      if (!v) { console.log(`\n${num}: NOT FOUND — push first.`); continue; }
      const led = [...v.matchAll(/<LEDGERENTRIES\.LIST>([\s\S]*?)<\/LEDGERENTRIES\.LIST>/g)]
        .map(x => x[1]).filter(x => /<[A-Z0-9_.]+>[^<\s]/.test(x));
      console.log(`\n${num}`);
      for (const l of led)
        console.log(`  ${fld(l, "LEDGERNAME").padEnd(26)} deemedPos=${fld(l, "ISDEEMEDPOSITIVE").padEnd(4)} ${inr(lead(fld(l, "AMOUNT")))}`);
      const stock = [...v.matchAll(/<ALLINVENTORYENTRIES\.LIST>([\s\S]*?)<\/ALLINVENTORYENTRIES\.LIST>/g)]
        .map(x => x[1]).filter(x => /<[A-Z0-9_.]+>[^<\s]/.test(x));
      for (const s of stock) console.log(`  stock ${fld(s, "STOCKITEMNAME").slice(0, 28).padEnd(30)} ${inr(lead(fld(s, "AMOUNT")))}`);
      // GSTR-1 classifies on these, not on the amounts.
      const idFields = ["GSTREGISTRATIONTYPE", "PARTYGSTIN", "PLACEOFSUPPLY", "STATENAME", "CONSIGNEEGSTIN", "PARTYMAILINGNAME", "PARTYPINCODE"];
      const missing = idFields.filter(t => !fld(v, t));
      console.log(`  GST identity: ${idFields.filter(t => fld(v, t)).map(t => `${t}=${fld(v, t)}`).join("  ") || "(NONE)"}`);
      if (missing.length) console.log(`  MISSING: ${missing.join(", ")}`);
    }

    console.log(`\n${"─".repeat(66)}`);
    console.log("Both vouchers are now in the books for the same party, item, quantity");
    console.log("and rate, differing only in how the discount line is encoded.");
    console.log("\nTo settle the question, open Tally and compare these two invoices in:");
    console.log("  Gateway → Display → Statutory Reports → GST → GSTR-1");
    console.log(`  (or the GST Sales Register) — look at TAXABLE VALUE for`);
    console.log(`  ${NATIVE_NUM} vs ${DEBIT_NUM}.`);
    console.log("\nIf both show the same taxable value, the encodings are equivalent for");
    console.log("filing and we default to the native one because it matches the books.");
    console.log("If they differ, the one matching taxable = gross − discount is correct.");
    console.log("\nThen: npx tsx scripts/verify-gstr1-discount.ts --cleanup");
    return;
  }

  console.log("Unknown mode. Use --probe | --push | --compare | --cleanup");
}

main().catch(e => console.error("FAILED:", e.message));
