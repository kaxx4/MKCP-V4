/**
 * Round-trip fidelity harness — full-detail vouchers.
 *
 * Builds vouchers with the SAME header profile real MK Cycles vouchers carry
 * (party address, GSTIN, state, place of supply, consignee block, entry mode),
 * sourced from the live Tally ledger master rather than hand-authored. Pushes
 * them, pulls the Day Book back, and diffs field by field.
 *
 * Three rules this exists to enforce, all of which fail SILENTLY in Tally:
 *   1. Ledger names are whitespace-significant. `PURCHASE ( GST W.B. )` has one
 *      space; `SALES  ( GST W.B. )` has two. Send the wrong one and Tally
 *      returns CREATED=1 while dropping the accounting allocation entirely.
 *   2. The unit token must match the item's own base unit exactly, or Tally
 *      voids qty and rate without erroring.
 *   3. Party state decides CGST+SGST vs IGST. Omit it and the tax is wrong in
 *      GSTR-1 while the voucher looks perfect.
 *
 *   npx tsx scripts/roundtrip-verify.ts          # build + report, nothing written
 *   npx tsx scripts/roundtrip-verify.ts --push   # push, pull back, diff
 */
import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { convertCompanies } from "../src/converters/convert.js";

const TALLY_URL = process.env.TALLY_URL || "http://localhost:9000";
const PUSH = process.argv.includes("--push");
const TAG = `RT${Date.now().toString().slice(-6)}`;

/**
 * A REMOTEID, so this harness can clean up after itself.
 *
 * It pushed without one, and a voucher created without a REMOTEID is
 * PERMANENTLY unaddressable: it is the only handle Tally accepts for Alter,
 * Cancel or Delete — GUID and VCHKEY both fail. So every run left its four
 * vouchers in the books for a human to delete by hand in the Tally UI, and
 * four became eight became twelve.
 *
 * That is guardrail G5 ("every write carries identity, from creation"), and the
 * harness that exists to verify pushes was the thing breaking it.
 */
function remoteIdFor(s: { type: string; number: string }): string {
  return `MKCP-RT|${s.type}|${s.number}`;
}

const D = new Date();
const YMD = `${D.getFullYear()}${String(D.getMonth() + 1).padStart(2, "0")}${String(D.getDate()).padStart(2, "0")}`;
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

const OUR_STATE = "West Bengal";
const OUR_GSTIN = "19AADCM6953C1ZE";
const OUR_NAME = "M.K.CYCLES (P) LTD.";
const OUR_PIN = "700001";
const OUR_ADDR = ["9/12, Lal Bazaar Street, Kolkata : 700001", "PAN: AADCM6953C   PHONE : 7604057003, 9831640650"];
const GODOWN = "Main Location", BATCH = "Primary Batch";

// ── XML helpers ─────────────────────────────────────────────────────────────
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const unesc = (s: string) => s
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d)).replace(/&amp;/g, "&");
const fld = (b: string, t: string) => {
  const m = new RegExp(`<${t}[^>]*>([^<]*)</${t}>`).exec(b);
  return m ? unesc(m[1].trim()) : "";
};
/** FIX 2: quantities come back as "8 PC =  2.00 PKG" — take the LEADING number only. */
const qtyOf = (s: string) => { const m = /^\s*(-?[\d.]+)/.exec(s.replace(/,/g, "")); return m ? parseFloat(m[1]) : NaN; };
const amtOf = (s: string) => { const m = /^\s*(-?[\d.]+)/.exec(s.replace(/[,\s]/g, "")); return m ? parseFloat(m[1]) : NaN; };
const rateOf = (s: string) => { const m = /^\s*(-?[\d.]+)/.exec(s.replace(/,/g, "")); return m ? parseFloat(m[1]) : NaN; };
/** Sub-lists, with Tally's empty placeholder blocks dropped — a Collection
 *  emits `<ALLINVENTORYENTRIES.LIST></...>` even on vouchers with no stock. */
const listOf = (b: string, t: string) =>
  [...b.matchAll(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`, "g"))]
    .map(m => m[1])
    .filter(x => /<[A-Z0-9_.]+>[^<\s]/.test(x));
const r2 = (x: number) => Math.round(x * 100) / 100;
const signed = (a: number, dr: boolean) => r2(dr ? -Math.abs(a) : Math.abs(a));

function coll(id: string, type: string, fields: string[], company: string) {
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>${id}</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="${id}" ISMODIFY="No"><TYPE>${type}</TYPE>
${fields.map(x => `<NATIVEMETHOD>${x}</NATIVEMETHOD>`).join("\n")}
</COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
}
/**
 * Read today's vouchers back.
 *
 * A Collection with a date filter, NOT the Day Book report: Day Book ignores
 * `SVFROMDATE`/`SVTODATE` on this install and always returns Tally's own current
 * date, so the moment the calendar rolled past it every read-back came back
 * empty and reported perfectly good vouchers as missing.
 */
const dayBook = (company: string) => `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>RtVerify</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE>
<COLLECTION NAME="RtVerify" ISMODIFY="No"><TYPE>Voucher</TYPE>
<NATIVEMETHOD>Date</NATIVEMETHOD><NATIVEMETHOD>VoucherNumber</NATIVEMETHOD>
<NATIVEMETHOD>VoucherTypeName</NATIVEMETHOD><NATIVEMETHOD>Narration</NATIVEMETHOD>
<NATIVEMETHOD>PartyLedgerName</NATIVEMETHOD><NATIVEMETHOD>PartyGSTIN</NATIVEMETHOD>
<NATIVEMETHOD>StateName</NATIVEMETHOD><NATIVEMETHOD>PlaceOfSupply</NATIVEMETHOD>
<NATIVEMETHOD>PartyMailingName</NATIVEMETHOD><NATIVEMETHOD>ConsigneeStateName</NATIVEMETHOD>
<NATIVEMETHOD>AllLedgerEntries</NATIVEMETHOD><NATIVEMETHOD>LedgerEntries</NATIVEMETHOD>
<NATIVEMETHOD>AllInventoryEntries</NATIVEMETHOD>
<FILTER>RtVerifyDate</FILTER></COLLECTION>
<SYSTEM TYPE="Formulae" NAME="RtVerifyDate">($$YearOfDate:$Date * 10000 + $$MonthOfDate:$Date * 100 + $$DayOfDate:$Date) = ${YMD}</SYSTEM>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;

// ── Masters ─────────────────────────────────────────────────────────────────
interface Ledger { name: string; parent: string; gstin: string; state: string; pin: string; mailing: string; addr: string[]; }
interface Item { name: string; unit: string; denom: number; rate: number; stock: number; gst: number; }
interface Bill { name: string; party: string; closing: number; }

/** FIX 1: never hardcode a ledger name — resolve it against what Tally actually holds. */
function makeResolver(ledgers: Ledger[]) {
  const exact = new Map(ledgers.map(l => [l.name, l]));
  const loose = new Map(ledgers.map(l => [l.name.replace(/\s+/g, " ").trim().toUpperCase(), l]));
  return (want: string): Ledger => {
    const hit = exact.get(want);
    if (hit) return hit;
    const near = loose.get(want.replace(/\s+/g, " ").trim().toUpperCase());
    if (near) {
      console.log(`  ⚠ ledger "${want}" does not exist — Tally spells it "${near.name}". Using the real one.`);
      return near;
    }
    throw new Error(`Ledger "${want}" not found in this company — refusing to push a voucher that would silently drop it.`);
  };
}

async function masters(company: string) {
  const [ledXml, itemXml, billXml] = await Promise.all([
    tallyPost(TALLY_URL, coll("RtLed", "Ledger",
      ["Name", "Parent", "PartyGSTIN", "GSTIN", "LedStateName", "PinCode", "MailingName", "Address"], company), 180_000, true) as Promise<string>,
    tallyPost(TALLY_URL, coll("RtItem", "StockItem",
      ["Name", "BaseUnits", "Denominator", "ClosingBalance", "ClosingRate", "GSTDetails"], company), 180_000, true) as Promise<string>,
    tallyPost(TALLY_URL, coll("RtBill", "Bills", ["Name", "Parent", "ClosingBalance"], company), 180_000, true) as Promise<string>,
  ]);

  const ledgers: Ledger[] = [...ledXml.matchAll(/<LEDGER\b[^>]*>[\s\S]*?<\/LEDGER>/g)].map(m => m[0]).map(b => ({
    name: fld(b, "NAME"), parent: fld(b, "PARENT"),
    gstin: fld(b, "PARTYGSTIN") || fld(b, "GSTIN"),
    state: fld(b, "LEDSTATENAME"), pin: fld(b, "PINCODE"),
    mailing: fld(b, "MAILINGNAME") || fld(b, "NAME"),
    addr: [...b.matchAll(/<ADDRESS>([^<]*)<\/ADDRESS>/g)].map(x => unesc(x[1].trim())).filter(Boolean),
  })).filter(l => l.name);

  const items: Item[] = [...itemXml.matchAll(/<STOCKITEM\b[^>]*>[\s\S]*?<\/STOCKITEM>/g)].map(m => m[0]).map(b => {
    const g = /<GSTRATEDUTYHEAD>\s*CGST\s*<\/GSTRATEDUTYHEAD>[\s\S]{0,300}?<GSTRATE>([^<]*)<\/GSTRATE>/.exec(b);
    return { name: fld(b, "NAME"), unit: fld(b, "BASEUNITS") || "PC",
      denom: amtOf(fld(b, "DENOMINATOR")) || 1, rate: amtOf(fld(b, "CLOSINGRATE")) || 0,
      stock: qtyOf(fld(b, "CLOSINGBALANCE")) || 0, gst: g ? parseFloat(g[1]) || 0 : 0 };
  }).filter(i => i.name);

  const bills: Bill[] = [...billXml.matchAll(/<BILL\b[^>]*>[\s\S]*?<\/BILL>/g)].map(m => m[0])
    .map(b => ({ name: fld(b, "NAME"), party: fld(b, "PARENT"), closing: amtOf(fld(b, "CLOSINGBALANCE")) || 0 }))
    .filter(b => b.name && b.party && Math.abs(b.closing) > 1 && Math.abs(b.closing) < 5_000_000);

  return { ledgers, items, bills };
}

// ── Voucher construction, with the full header profile ──────────────────────
interface Line { item: Item; qty: number; rate: number; amount: number; }
/** Bank instrument detail. Without this Tally opens the "Bank Allocation" popup
 *  on every voucher that touches a bank ledger — 1,275 of the company's real
 *  vouchers carry it, so it is the norm, not an extra. INSTRUMENTNUMBER is the
 *  UTR / cheque number, i.e. exactly what a bank screenshot yields. */
interface BankAlloc { transactionType: string; transferMode: string; instrumentNumber: string; favouring: string; }
interface Spec {
  label: string; type: string; number: string; narration: string;
  party: Ledger; isInvoice: boolean; inward: boolean;
  lines: Line[]; acctLedger?: Ledger;
  ledgers: Array<{ led: Ledger; amount: number; dr: boolean; isParty: boolean;
    bills?: Array<{ name: string; type: string; amount: number }>; bank?: BankAlloc }>;
  reference?: string;
}

/** FIX 3: the header profile real vouchers carry — address, GSTIN, state, consignee. */
function header(s: Spec): string {
  const p = s.party;
  const buyerName = s.inward ? OUR_NAME : p.mailing;
  const buyerAddr = s.inward ? OUR_ADDR : p.addr;
  const partyState = p.state || OUR_STATE;
  return [
    p.addr.length ? `<ADDRESS.LIST TYPE="String">${p.addr.map(a => `<ADDRESS>${esc(a)}</ADDRESS>`).join("")}</ADDRESS.LIST>` : "",
    buyerAddr.length ? `<BASICBUYERADDRESS.LIST TYPE="String">${buyerAddr.map(a => `<BASICBUYERADDRESS>${esc(a)}</BASICBUYERADDRESS>`).join("")}</BASICBUYERADDRESS.LIST>` : "",
    `<DATE>${YMD}</DATE>`,
    s.reference ? `<REFERENCEDATE>${YMD}</REFERENCEDATE>` : "",
    `<VOUCHERTYPENAME>${esc(s.type)}</VOUCHERTYPENAME>`,
    `<VOUCHERNUMBER>${esc(s.number)}</VOUCHERNUMBER>`,
    s.reference ? `<REFERENCE>${esc(s.reference)}</REFERENCE>` : "",
    `<NARRATION>${esc(s.narration)}</NARRATION>`,
    `<PARTYLEDGERNAME>${esc(p.name)}</PARTYLEDGERNAME>`,
    s.isInvoice ? `<PARTYNAME>${esc(p.name)}</PARTYNAME>` : "",
    s.isInvoice ? `<BASICBASEPARTYNAME>${esc(p.name)}</BASICBASEPARTYNAME>` : "",
    s.isInvoice ? `<BASICBUYERNAME>${esc(buyerName)}</BASICBUYERNAME>` : "",
    `<PARTYMAILINGNAME>${esc(p.mailing)}</PARTYMAILINGNAME>`,
    p.gstin ? `<PARTYGSTIN>${esc(p.gstin)}</PARTYGSTIN>` : "",
    p.pin ? `<PARTYPINCODE>${esc(p.pin)}</PARTYPINCODE>` : "",
    `<STATENAME>${esc(partyState)}</STATENAME>`,
    `<PLACEOFSUPPLY>${esc(s.inward ? OUR_STATE : partyState)}</PLACEOFSUPPLY>`,
    `<CMPGSTIN>${OUR_GSTIN}</CMPGSTIN>`,
    `<CONSIGNEEGSTIN>${s.inward ? OUR_GSTIN : (p.gstin || "")}</CONSIGNEEGSTIN>`,
    `<CONSIGNEEMAILINGNAME>${esc(s.inward ? OUR_NAME : p.mailing)}</CONSIGNEEMAILINGNAME>`,
    `<CONSIGNEEPINCODE>${esc(s.inward ? OUR_PIN : (p.pin || ""))}</CONSIGNEEPINCODE>`,
    `<CONSIGNEESTATENAME>${esc(s.inward ? OUR_STATE : partyState)}</CONSIGNEESTATENAME>`,
    `<CONSIGNEECOUNTRYNAME>India</CONSIGNEECOUNTRYNAME>`,
    s.isInvoice ? `<VCHENTRYMODE>Item Invoice</VCHENTRYMODE>` : "",
    s.isInvoice ? `<ISINVOICE>Yes</ISINVOICE>` : `<ISINVOICE>No</ISINVOICE>`,
  ].filter(Boolean).join("\n");
}

function buildXml(company: string, s: Spec): string {
  const objView = s.isInvoice ? "Invoice Voucher View" : "Accounting Voucher View";
  const led = s.ledgers.map(e => {
    const tag = s.isInvoice ? "LEDGERENTRIES.LIST" : "ALLLEDGERENTRIES.LIST";
    const bills = (e.bills ?? []).map(b => `<BILLALLOCATIONS.LIST><NAME>${esc(b.name)}</NAME>`
      + `<BILLTYPE>${esc(b.type)}</BILLTYPE><AMOUNT>${signed(b.amount, e.dr)}</AMOUNT></BILLALLOCATIONS.LIST>`).join("");
    const bank = e.bank ? `<BANKALLOCATIONS.LIST>`
      + `<DATE>${YMD}</DATE><INSTRUMENTDATE>${YMD}</INSTRUMENTDATE><BANKERSDATE>${YMD}</BANKERSDATE>`
      + `<TRANSACTIONTYPE>${esc(e.bank.transactionType)}</TRANSACTIONTYPE>`
      + `<TRANSFERMODE>${esc(e.bank.transferMode)}</TRANSFERMODE>`
      + `<INSTRUMENTNUMBER>${esc(e.bank.instrumentNumber)}</INSTRUMENTNUMBER>`
      + `<PAYMENTFAVOURING>${esc(e.bank.favouring)}</PAYMENTFAVOURING>`
      + `<BANKPARTYNAME>${esc(e.bank.favouring)}</BANKPARTYNAME>`
      + `<PAYMENTMODE>Transacted</PAYMENTMODE><STATUS>No</STATUS>`
      + `<AMOUNT>${signed(e.amount, e.dr)}</AMOUNT></BANKALLOCATIONS.LIST>` : "";
    return `<${tag}><LEDGERNAME>${esc(e.led.name)}</LEDGERNAME>`
      + `<ISDEEMEDPOSITIVE>${e.dr ? "Yes" : "No"}</ISDEEMEDPOSITIVE>`
      + `<ISPARTYLEDGER>${e.isParty ? "Yes" : "No"}</ISPARTYLEDGER>`
      + `<AMOUNT>${signed(e.amount, e.dr)}</AMOUNT>${bills}${bank}</${tag}>`;
  }).join("\n");

  const inv = s.lines.map(l => {
    const a = signed(l.amount, s.inward);
    const q = `${l.qty} ${esc(l.item.unit)}`;
    return `<ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>${esc(l.item.name)}</STOCKITEMNAME>`
      + `<ISDEEMEDPOSITIVE>${s.inward ? "Yes" : "No"}</ISDEEMEDPOSITIVE>`
      + `<RATE>${l.rate.toFixed(2)}/${esc(l.item.unit)}</RATE><AMOUNT>${a}</AMOUNT>`
      + `<ACTUALQTY>${q}</ACTUALQTY><BILLEDQTY>${q}</BILLEDQTY>`
      + `<BATCHALLOCATIONS.LIST><GODOWNNAME>${GODOWN}</GODOWNNAME><BATCHNAME>${BATCH}</BATCHNAME>`
      + `<AMOUNT>${a}</AMOUNT><ACTUALQTY>${q}</ACTUALQTY><BILLEDQTY>${q}</BILLEDQTY></BATCHALLOCATIONS.LIST>`
      + (s.acctLedger ? `<ACCOUNTINGALLOCATIONS.LIST><LEDGERNAME>${esc(s.acctLedger.name)}</LEDGERNAME>`
        + `<ISDEEMEDPOSITIVE>${s.inward ? "Yes" : "No"}</ISDEEMEDPOSITIVE><ISPARTYLEDGER>No</ISPARTYLEDGER>`
        + `<AMOUNT>${a}</AMOUNT></ACCOUNTINGALLOCATIONS.LIST>` : "")
      + `</ALLINVENTORYENTRIES.LIST>`;
  }).join("\n");

  return `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA>
<REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME><STATICVARIABLES>
<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC>
<REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">
<VOUCHER REMOTEID="${esc(remoteIdFor(s))}" VCHTYPE="${esc(s.type)}" ACTION="Create" OBJVIEW="${objView}">
${header(s)}
${led}
${inv}
</VOUCHER></TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
}

// ── Diff ────────────────────────────────────────────────────────────────────
function diff(s: Spec, v: string): string[] {
  const bad: string[] = [];
  const eq = (a: number, b: number) => Math.abs(a - b) < 0.02;

  for (const key of ["PARTYGSTIN", "STATENAME", "PLACEOFSUPPLY", "PARTYMAILINGNAME", "CONSIGNEESTATENAME"]) {
    const sent = new RegExp(`<${key}>([^<]*)</${key}>`).exec(header(s))?.[1];
    if (!sent) continue;
    const got = fld(v, key);
    if (got !== unesc(sent)) bad.push(`${key}: sent "${unesc(sent)}" stored "${got}"`);
  }

  const stored = [...listOf(v, "LEDGERENTRIES\\.LIST"), ...listOf(v, "ALLLEDGERENTRIES\\.LIST")];
  for (const e of s.ledgers) {
    const want = signed(e.amount, e.dr);
    const hit = stored.find(x => fld(x, "LEDGERNAME") === e.led.name && eq(amtOf(fld(x, "AMOUNT")), want));
    if (!hit) {
      const named = stored.find(x => fld(x, "LEDGERNAME") === e.led.name);
      bad.push(named ? `ledger "${e.led.name}": sent ${want} stored ${amtOf(fld(named, "AMOUNT"))}`
                     : `ledger "${e.led.name}": NOT STORED`);
      continue;
    }
    for (const b of e.bills ?? []) {
      const bh = listOf(hit, "BILLALLOCATIONS\\.LIST").find(x => fld(x, "NAME") === b.name);
      if (!bh) { bad.push(`bill "${b.name}": NOT STORED`); continue; }
      if (fld(bh, "BILLTYPE") !== b.type) bad.push(`bill "${b.name}": type sent ${b.type} stored ${fld(bh, "BILLTYPE")}`);
      if (!eq(amtOf(fld(bh, "AMOUNT")), signed(b.amount, e.dr))) bad.push(`bill "${b.name}": amount mismatch`);
    }
    if (e.bank) {
      const ba = listOf(hit, "BANKALLOCATIONS\\.LIST").find(x => x.trim().length > 5);
      if (!ba) bad.push(`bank allocation on "${e.led.name}": NOT STORED (Tally will prompt on every entry)`);
      else {
        if (fld(ba, "INSTRUMENTNUMBER") !== e.bank.instrumentNumber)
          bad.push(`bank UTR: sent "${e.bank.instrumentNumber}" stored "${fld(ba, "INSTRUMENTNUMBER")}"`);
        if (fld(ba, "TRANSACTIONTYPE") !== e.bank.transactionType)
          bad.push(`bank type: sent "${e.bank.transactionType}" stored "${fld(ba, "TRANSACTIONTYPE")}"`);
        if (fld(ba, "TRANSFERMODE") !== e.bank.transferMode)
          bad.push(`bank transfer mode: sent "${e.bank.transferMode}" stored "${fld(ba, "TRANSFERMODE")}"`);
      }
    }
  }

  const inv = listOf(v, "ALLINVENTORYENTRIES\\.LIST");
  if (inv.length !== s.lines.length) bad.push(`stock lines: sent ${s.lines.length} stored ${inv.length}`);
  for (const l of s.lines) {
    const hit = inv.find(x => fld(x, "STOCKITEMNAME") === l.item.name);
    if (!hit) { bad.push(`item "${l.item.name}": NOT STORED`); continue; }
    if (!eq(amtOf(fld(hit, "AMOUNT")), signed(l.amount, s.inward))) bad.push(`item "${l.item.name}": amount mismatch`);
    if (!eq(qtyOf(fld(hit, "ACTUALQTY")), l.qty)) bad.push(`item "${l.item.name}": qty sent ${l.qty} stored "${fld(hit, "ACTUALQTY")}"`);
    if (!eq(rateOf(fld(hit, "RATE")), l.rate)) bad.push(`item "${l.item.name}": rate sent ${l.rate} stored "${fld(hit, "RATE")}"`);
    if (fld(hit, "GODOWNNAME") !== GODOWN) bad.push(`item "${l.item.name}": godown not stored`);
    if (s.acctLedger && !listOf(hit, "ACCOUNTINGALLOCATIONS\\.LIST").some(a => fld(a, "LEDGERNAME") === s.acctLedger!.name))
      bad.push(`item "${l.item.name}": accounting ledger "${s.acctLedger.name}" NOT STORED`);
  }
  return bad;
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const company = convertCompanies(await tallyPost(TALLY_URL, HEALTH_XML, 10_000))[0]?.name;
  if (!company) throw new Error("No company loaded");
  console.log(`→ ${company}\n→ ${PUSH ? "PUSH + VERIFY" : "DRY RUN"}   tag ${TAG}\n`);

  const { ledgers, items, bills } = await masters(company);
  const L = makeResolver(ledgers);
  console.log(`${ledgers.length} ledgers, ${items.length} items, ${bills.length} open bills\n`);

  const byParty = (list: Bill[]) => {
    const m = new Map<string, Bill[]>();
    for (const b of list) { if (!m.has(b.party)) m.set(b.party, []); m.get(b.party)!.push(b); }
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length);
  };
  const custBills = byParty(bills.filter(b => b.closing < 0))[0];
  const suppBills = byParty(bills.filter(b => b.closing > 0))[0];
  const sellable = items.filter(i => i.stock > 20 && i.rate > 20 && i.gst === 9).slice(0, 6);

  const specs: Spec[] = [];

  if (custBills && sellable.length) {
    const cust = L(custBills[0]);
    const lines: Line[] = sellable.map((it, i) => {
      const qty = it.denom * (2 + (i % 3));
      return { item: it, qty, rate: it.rate, amount: r2(qty * it.rate) };
    });
    const goods = r2(lines.reduce((a, l) => a + l.amount, 0));
    const local = (cust.state || OUR_STATE) === OUR_STATE;
    const tax = r2(goods * 0.18);
    const half = r2(tax / 2);
    const gross = r2(goods + (local ? half * 2 : tax));
    const total = Math.round(gross), round = r2(total - gross);
    const entries: Spec["ledgers"] = [
      { led: cust, amount: total, dr: true, isParty: true,
        bills: [{ name: `${TAG}/S`, type: "New Ref", amount: total }] },
    ];
    if (local) {
      entries.push({ led: L("OUTPUT CGST"), amount: half, dr: false, isParty: false });
      entries.push({ led: L("OUTPUT SGST"), amount: half, dr: false, isParty: false });
    } else entries.push({ led: L("OUTPUT IGST"), amount: tax, dr: false, isParty: false });
    if (Math.abs(round) >= 0.01)
      entries.push({ led: L("ROUNDED OFF"), amount: Math.abs(round), dr: round < 0, isParty: false });
    specs.push({ label: "sales", type: "Sales", number: `${TAG}/S`, narration: `${TAG} round-trip sales`,
      party: cust, isInvoice: true, inward: false, lines, acctLedger: L("SALES  ( GST W.B. )"), ledgers: entries });
  }

  if (suppBills && sellable.length) {
    const supp = L(suppBills[0]);
    const lines: Line[] = sellable.slice(0, 3).map((it, i) => {
      const qty = it.denom * (4 + i), rate = r2(it.rate * 0.8);
      return { item: it, qty, rate, amount: r2(qty * rate) };
    });
    const goods = r2(lines.reduce((a, l) => a + l.amount, 0));
    // Party state decides the tax ledger — Punjab/UP/Delhi → IGST, West Bengal → CGST+SGST.
    // Verified across 455 real purchases with no exception.
    const local = (supp.state || "") === OUR_STATE;
    const tax = r2(goods * 0.05);                       // bicycle parts, HSN 87149xxx
    const half = r2(tax / 2);
    const gross = r2(goods + (local ? half * 2 : tax));
    const total = Math.round(gross), round = r2(total - gross);
    const pLed: Spec["ledgers"] = [{ led: supp, amount: total, dr: false, isParty: true,
      bills: [{ name: `${TAG}/INV`, type: "New Ref", amount: total }] }];
    if (local) {
      pLed.push({ led: L("INPUT CGST"), amount: half, dr: true, isParty: false });
      pLed.push({ led: L("INPUT SGST"), amount: half, dr: true, isParty: false });
    } else pLed.push({ led: L("INPUT IGST"), amount: tax, dr: true, isParty: false });
    if (Math.abs(round) >= 0.01)
      pLed.push({ led: L("ROUNDED OFF"), amount: Math.abs(round), dr: round > 0, isParty: false });
    specs.push({ label: "purchase", type: "Purchase", number: `${TAG}/INV`, reference: `${TAG}/INV`,
      narration: `${TAG} round-trip purchase`, party: supp, isInvoice: true, inward: true, lines,
      acctLedger: L(local ? "PURCHASE ( GST W.B. )" : "PURCHASE ( GST CENTRAL )"),
      ledgers: pLed });
  }

  if (custBills) {
    const cust = L(custBills[0]);
    const pick = custBills[1].slice(0, 3).map(b => ({ name: b.name, type: "Agst Ref", amount: Math.abs(b.closing) }));
    const total = r2(pick.reduce((a, b) => a + b.amount, 0));
    specs.push({ label: "receipt", type: "Receipt", number: `${TAG}/R`, narration: `${TAG} RTGS RECEIVED`,
      party: cust, isInvoice: false, inward: false, lines: [],
      ledgers: [
        { led: L("HDFC BANK"), amount: total, dr: true, isParty: false,
          bank: { transactionType: "Cheque/DD", transferMode: "NEFT",
                  instrumentNumber: `HDFCN${TAG.slice(-6)}01`, favouring: cust.name } },
        { led: cust, amount: total, dr: false, isParty: true, bills: pick },
      ] });
  }

  if (suppBills) {
    const supp = L(suppBills[0]);
    const pick = suppBills[1].slice(0, 3).map(b => ({ name: b.name, type: "Agst Ref", amount: Math.abs(b.closing) }));
    const total = r2(pick.reduce((a, b) => a + b.amount, 0));
    specs.push({ label: "payment", type: "Payment", number: `${TAG}/P`, narration: `${TAG} AS PER BILL`,
      party: supp, isInvoice: false, inward: false, lines: [],
      ledgers: [
        { led: supp, amount: total, dr: true, isParty: true, bills: pick },
        { led: L("HDFC BANK"), amount: total, dr: false, isParty: false,
          bank: { transactionType: "Cheque/DD", transferMode: "NEFT",
                  instrumentNumber: `HDFCN${TAG.slice(-6)}02`, favouring: supp.name } },
      ] });
  }

  for (const s of specs) {
    const bal = s.ledgers.reduce((a, e) => a + (e.dr ? -e.amount : e.amount), 0)
      + s.lines.reduce((a, l) => a + (s.inward ? -l.amount : l.amount), 0);
    console.log(`  ${s.label.padEnd(9)} ${s.number.padEnd(14)} party="${s.party.name}" state=${s.party.state || "—"} gstin=${s.party.gstin || "—"}`);
    console.log(`  ${" ".repeat(9)} ${String(s.ledgers.length)} ledger + ${String(s.lines.length)} stock, balance ${r2(bal)}, header ${header(s).split("\n").length} fields`);
  }
  if (!PUSH) { console.log("\nDry run — add --push."); return; }

  console.log("\nPushing…");
  const sent: Spec[] = [];
  for (const s of specs) {
    const resp: string = await tallyPost(TALLY_URL, buildXml(company, s), 60_000, true);
    const g = (t: string) => (new RegExp(`<${t}>\\s*(\\d+)\\s*</${t}>`).exec(resp) || [])[1] ?? "?";
    const le = /<LINEERROR>([^<]*)/.exec(resp);
    if (g("CREATED") === "1") { console.log(`  ✓ ${s.label} → ${g("LASTVCHID")}`); sent.push(s); }
    else console.log(`  ✗ ${s.label} — created=${g("CREATED")} errors=${g("ERRORS")} exceptions=${g("EXCEPTIONS")}${le ? ` — ${le[1]}` : ""}`);
  }

  console.log("\nPulling the Day Book back…");
  const book: string = await tallyPost(TALLY_URL, dayBook(company), 180_000, true);
  const stored = [...book.matchAll(/<VOUCHER\b[^>]*>[\s\S]*?<\/VOUCHER>/g)].map(m => m[0]);
  console.log(`  ${stored.length} vouchers on file today\n${"─".repeat(66)}`);

  let clean = 0;
  for (const s of sent) {
    const v = stored.find(x => fld(x, "VOUCHERNUMBER") === s.number);
    if (!v) { console.log(`✗ ${s.label}: NOT FOUND on read-back`); continue; }
    const bad = diff(s, v);
    if (!bad.length) { console.log(`✓ ${s.label.padEnd(9)} ${s.number} — round-tripped exactly`); clean++; }
    else { console.log(`✗ ${s.label.padEnd(9)} ${s.number} — ${bad.length} difference(s)`); for (const b of bad) console.log(`      ${b}`); }
  }
  console.log("─".repeat(66));
  console.log(`${clean}/${sent.length} round-tripped with full fidelity`);
}

main().catch(e => { console.error(`✗ ${e.message}`); process.exit(1); });
