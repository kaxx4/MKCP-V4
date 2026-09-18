/**
 * Realistic voucher simulation — builds vouchers shaped like the ones MK Cycles
 * actually keys, not minimal test stubs. Everything is sourced live from Tally:
 * real parties, real stock items at their real closing rates, real GST rates,
 * and real outstanding bill references to settle against.
 *
 * Produces, matching the patterns measured across 2,742 live vouchers:
 *   sales    — multi-line GST invoice, godown + batch per line, rounding, New Ref
 *   purchase — supplier invoice under the supplier's own number
 *   receipt  — settles real open customer bills with Agst Ref
 *   payment  — settles real open supplier bills with Agst Ref
 *
 * SAFE BY DEFAULT: prints what it would send. Nothing is written without --push.
 *
 *   npx tsx scripts/simulate-real-vouchers.ts
 *   npx tsx scripts/simulate-real-vouchers.ts --push
 *   npx tsx scripts/simulate-real-vouchers.ts --push sales
 */
import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { convertCompanies } from "../src/converters/convert.js";
import { pushVoucherToTally, buildVoucherImportXml } from "../src/services/voucherPusher.js";
import { loadMasters } from "../src/services/tallyMasters.js";
import type { VoucherPayload, LedgerEntry, InventoryEntry } from "../src/types.js";

const TALLY_URL = process.env.TALLY_URL || "http://localhost:9000";
const args = process.argv.slice(2);
const PUSH = args.includes("--push");
const ONLY = args.filter(a => !a.startsWith("--")).flatMap(a => a.split(",")).map(s => s.trim().toLowerCase());

const TAG = `SIM${Date.now().toString().slice(-6)}`;
const TODAY = new Date().toISOString().slice(0, 10);

const GODOWN = "Main Location";
const BATCH = "Primary Batch";
const SALES_LEDGER = "SALES  ( GST W.B. )";
const BANK = "HDFC BANK";
const OUT_CGST = "OUTPUT CGST";
const OUT_SGST = "OUTPUT SGST";
const ROUNDING = "ROUNDED OFF";

// ── tiny XML helpers (Tally returns typed nodes) ────────────────────────────
/** Tally returns names XML-escaped. Decode them, or a stock item called
 *  `PLIER BOX JT. 10" ( 50 PCS )` comes back with a literal `&quot;` in it and
 *  no longer matches anything when sent back. Cycle parts are full of inch
 *  marks, so this is the common case, not an edge case. */
const unescapeXml = (s: string): string =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">")
   .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
   .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
   .replace(/&amp;/g, "&");            // last, so &amp;quot; doesn't double-decode

const field = (b: string, t: string): string => {
  const m = new RegExp(`<${t}[^>]*>([^<]*)</${t}>`).exec(b);
  return m ? unescapeXml(m[1].trim()) : "";
};
const numOf = (s: string): number => parseFloat(s.replace(/[^\d.\-]/g, "")) || 0;

function collectionXml(id: string, type: string, fields: string[], company: string): string {
  return `<ENVELOPE>
<HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>${id}</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${company}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="${id}" ISMODIFY="No"><TYPE>${type}</TYPE>
${fields.map(f => `<NATIVEMETHOD>${f}</NATIVEMETHOD>`).join("\n")}
</COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
}

interface Bill { name: string; party: string; date: string; closing: number; }
interface Item { name: string; unit: string; denominator: number; rate: number; stock: number; gstRate: number; }

async function raw(xml: string): Promise<string> {
  return await tallyPost(TALLY_URL, xml, 180_000, true);
}

async function getBills(company: string): Promise<Bill[]> {
  const xml = await raw(collectionXml("SimBills", "Bills",
    ["Name", "Parent", "BillDate", "ClosingBalance"], company));
  return [...xml.matchAll(/<BILL\b[^>]*>[\s\S]*?<\/BILL>/g)]
    .map(m => m[0])
    .map(b => ({ name: field(b, "NAME"), party: field(b, "PARENT"), date: field(b, "BILLDATE"), closing: numOf(field(b, "CLOSINGBALANCE")) }))
    .filter(b => b.name && b.party && Math.abs(b.closing) > 1 && Math.abs(b.closing) < 5_000_000);
}

async function getItems(company: string): Promise<Item[]> {
  const xml = await raw(collectionXml("SimItems", "StockItem",
    ["Name", "BaseUnits", "Denominator", "ClosingBalance", "ClosingRate", "GSTDetails"], company));
  return [...xml.matchAll(/<STOCKITEM\b[^>]*>[\s\S]*?<\/STOCKITEM>/g)]
    .map(m => m[0])
    .map(b => {
      const gm = /<GSTRATEDUTYHEAD>\s*CGST\s*<\/GSTRATEDUTYHEAD>[\s\S]{0,300}?<GSTRATE>([^<]*)<\/GSTRATE>/.exec(b);
      return {
        name: field(b, "NAME"),
        unit: field(b, "BASEUNITS") || "PC",
        denominator: numOf(field(b, "DENOMINATOR")) || 1,
        rate: numOf(field(b, "CLOSINGRATE")),
        stock: numOf(field(b, "CLOSINGBALANCE")),
        gstRate: gm ? numOf(gm[1]) : 0,
      };
    })
    .filter(i => i.name);
}

const r2 = (n: number) => Math.round(n * 100) / 100;

// ── Sales: a real multi-line GST invoice ────────────────────────────────────
function buildSales(customer: string, items: Item[]): VoucherPayload {
  const lines: InventoryEntry[] = items.map((it, n) => {
    // Order in whole packs, the way the trade actually buys
    const qty = it.denominator * (2 + (n % 4));
    const amount = r2(qty * it.rate);
    return {
      stockItemName: it.name,
      quantity: qty,
      unit: it.unit,
      rate: it.rate,
      amount,
      isDeemedPositive: false,          // outward
      salesLedgerName: SALES_LEDGER,
      godownName: GODOWN,
      batchName: BATCH,
    };
  });

  const goods = r2(lines.reduce((s, l) => s + l.amount, 0));
  // Every simulated line is a 9 + 9 item, matching the West Bengal local pattern
  const cgst = r2(goods * 0.09);
  const sgst = r2(goods * 0.09);
  const grossTotal = r2(goods + cgst + sgst);
  const invoiceTotal = Math.round(grossTotal);
  const rounding = r2(invoiceTotal - grossTotal);

  const ledgerEntries: LedgerEntry[] = [
    {
      ledgerName: customer, amount: invoiceTotal, isDeemedPositive: true, isPartyLedger: true,
      // A sales invoice opens a new bill reference under its own number
      billAllocations: [{ name: `${TAG}/S`, billType: "New Ref", amount: invoiceTotal }],
    },
    { ledgerName: OUT_CGST, amount: cgst, isDeemedPositive: false, isPartyLedger: false },
    { ledgerName: OUT_SGST, amount: sgst, isDeemedPositive: false, isPartyLedger: false },
  ];
  if (Math.abs(rounding) >= 0.01) {
    ledgerEntries.push({
      ledgerName: ROUNDING,
      amount: Math.abs(rounding),
      isDeemedPositive: rounding < 0,   // a downward round is a debit
      isPartyLedger: false,
    });
  }

  return {
    voucherType: "Sales",
    date: TODAY,
    voucherNumber: `${TAG}/S`,
    narration: `${TAG} simulated sales invoice`,
    partyLedgerName: customer,
    isInvoice: true,
    ledgerEntries,
    inventoryEntries: lines,
  };
}

// ── Purchase: supplier's own invoice number ─────────────────────────────────
function buildPurchase(supplier: string, items: Item[], purchaseLedger: string): VoucherPayload {
  const lines: InventoryEntry[] = items.map((it, n) => {
    const qty = it.denominator * (5 + n);
    return {
      stockItemName: it.name,
      quantity: qty,
      unit: it.unit,
      rate: r2(it.rate * 0.82),          // bought below the selling rate
      amount: r2(qty * r2(it.rate * 0.82)),
      isDeemedPositive: true,            // inward
      salesLedgerName: purchaseLedger,
      godownName: GODOWN,
      batchName: BATCH,
    };
  });
  const total = r2(lines.reduce((s, l) => s + l.amount, 0));

  return {
    voucherType: "Purchase",
    date: TODAY,
    voucherNumber: `${TAG}/INV`,         // suppliers number their own bills
    reference: `${TAG}/INV`,
    narration: `${TAG} simulated purchase`,
    partyLedgerName: supplier,
    isInvoice: true,
    ledgerEntries: [{
      ledgerName: supplier, amount: total, isDeemedPositive: false, isPartyLedger: true,
      billAllocations: [{ name: `${TAG}/INV`, billType: "New Ref", amount: total }],
    }],
    inventoryEntries: lines,
  };
}

// ── Receipt: settle real open customer bills ────────────────────────────────
function buildReceipt(customer: string, bills: Bill[]): VoucherPayload {
  const settled = bills.map(b => ({ name: b.name, amount: Math.abs(b.closing) }));
  const total = r2(settled.reduce((s, b) => s + b.amount, 0));
  return {
    voucherType: "Receipt",
    date: TODAY,
    voucherNumber: `${TAG}/R`,
    narration: `${TAG} RTGS RECEIVED`,
    partyLedgerName: customer,
    isInvoice: false,
    ledgerEntries: [
      { ledgerName: BANK, amount: total, isDeemedPositive: true, isPartyLedger: false },
      {
        ledgerName: customer, amount: total, isDeemedPositive: false, isPartyLedger: true,
        billAllocations: settled.map(b => ({ name: b.name, billType: "Agst Ref" as const, amount: b.amount })),
      },
    ],
  };
}

// ── Payment: settle real open supplier bills ────────────────────────────────
function buildPayment(supplier: string, bills: Bill[]): VoucherPayload {
  const settled = bills.map(b => ({ name: b.name, amount: Math.abs(b.closing) }));
  const total = r2(settled.reduce((s, b) => s + b.amount, 0));
  return {
    voucherType: "Payment",
    date: TODAY,
    voucherNumber: `${TAG}/P`,
    narration: `${TAG} AS PER BILL`,
    partyLedgerName: supplier,
    isInvoice: false,
    ledgerEntries: [
      {
        ledgerName: supplier, amount: total, isDeemedPositive: true, isPartyLedger: true,
        billAllocations: settled.map(b => ({ name: b.name, billType: "Agst Ref" as const, amount: b.amount })),
      },
      { ledgerName: BANK, amount: total, isDeemedPositive: false, isPartyLedger: false },
    ],
  };
}

// ── Report + push ───────────────────────────────────────────────────────────
function describe(label: string, p: VoucherPayload) {
  const led = p.ledgerEntries.reduce((s, e) => s + (e.isDeemedPositive ? -e.amount : e.amount), 0);
  const inv = (p.isInvoice ? p.inventoryEntries ?? [] : []).reduce((s, e) => s + (e.isDeemedPositive ? -e.amount : e.amount), 0);
  console.log(`\n${"─".repeat(66)}\n${label.toUpperCase()}  ${p.voucherNumber}   party: ${p.partyLedgerName}`);
  for (const e of p.ledgerEntries) {
    console.log(`   ${e.isDeemedPositive ? "Dr" : "Cr"}  ${e.ledgerName.slice(0, 34).padEnd(36)} ${e.amount.toFixed(2).padStart(13)}`);
    for (const b of e.billAllocations ?? [])
      console.log(`        └─ ${b.billType.padEnd(9)} ${b.name.slice(0, 22).padEnd(24)} ${b.amount.toFixed(2).padStart(13)}`);
  }
  if (p.inventoryEntries?.length) {
    console.log(`   ${p.inventoryEntries.length} stock line(s):`);
    for (const l of p.inventoryEntries.slice(0, 4))
      console.log(`        ${l.stockItemName.slice(0, 30).padEnd(32)} ${String(l.quantity).padStart(5)} ${l.unit.padEnd(4)} @ ${l.rate.toFixed(2).padStart(9)} = ${l.amount.toFixed(2).padStart(12)}`);
    if (p.inventoryEntries.length > 4) console.log(`        … ${p.inventoryEntries.length - 4} more lines`);
  }
  console.log(`   balance: ledgers ${led.toFixed(2)} + inventory ${inv.toFixed(2)} = ${(led + inv).toFixed(2)}`);
}

async function main() {
  const companies = convertCompanies(await tallyPost(TALLY_URL, HEALTH_XML, 10_000));
  const company = companies[0]?.name;
  if (!company) throw new Error("No company loaded in Tally");
  console.log(`→ Tally ${TALLY_URL}\n→ Company "${company}"\n→ Mode ${PUSH ? "PUSH" : "DRY RUN"}   Tag ${TAG}`);

  console.log("\nPulling live masters and open bills…");
  const [bills, items] = await Promise.all([getBills(company), getItems(company)]);

  // Tally's sign convention: a debtor's open bill sits negative, a creditor's positive.
  const customerBills = bills.filter(b => b.closing < 0);
  const supplierBills = bills.filter(b => b.closing > 0);
  const groupBy = (bs: Bill[]) => {
    const m = new Map<string, Bill[]>();
    for (const b of bs) { if (!m.has(b.party)) m.set(b.party, []); m.get(b.party)!.push(b); }
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length);
  };
  const custByParty = groupBy(customerBills);
  const suppByParty = groupBy(supplierBills);

  // Sellable items: real stock, a real rate, and a 9+9 GST rate
  const sellable = items
    .filter(i => i.stock > 20 && i.rate > 20 && i.gstRate === 9)
    .slice(0, 12);

  console.log(`  ${items.length} items (${sellable.length} usable for a GST invoice)`);
  console.log(`  ${customerBills.length} open customer bills across ${custByParty.length} parties`);
  console.log(`  ${supplierBills.length} open supplier bills across ${suppByParty.length} parties`);

  const built: Record<string, VoucherPayload | null> = {
    sales:    custByParty[0] && sellable.length ? buildSales(custByParty[0][0], sellable) : null,
    purchase: suppByParty[0] && sellable.length ? buildPurchase(suppByParty[0][0], sellable.slice(0, 3), "PURCHASE  ( GST W.B. )") : null,
    receipt:  custByParty[0] ? buildReceipt(custByParty[0][0], custByParty[0][1].slice(0, 3)) : null,
    payment:  suppByParty[0] ? buildPayment(suppByParty[0][0], suppByParty[0][1].slice(0, 3)) : null,
  };

  const keys = ONLY.length ? ONLY : Object.keys(built);
  for (const k of keys) {
    const p = built[k];
    if (!p) { console.log(`\n[${k}] ⏭ skipped — no suitable live data`); continue; }
    describe(k, p);

    // Always prove it builds before deciding to send it — a malformed request
    // locks up Tally and costs a restart.
    let xml: string;
    try { xml = buildVoucherImportXml(company, p); }
    catch (e: any) { console.log(`   ✗ REJECTED locally: ${e.message}`); continue; }
    console.log(`   xml ${xml.length} bytes`);

    if (!PUSH) { console.log("   (dry run — not sent)"); continue; }
    try {
      const res = await pushVoucherToTally(TALLY_URL, company, p, await loadMasters(TALLY_URL, company));
      if (res.success) console.log(`   ✓ CREATED in Tally — voucher id ${res.lastVoucherId}`);
      else {
        console.log(`   ✗ REJECTED by Tally — created=${res.created} errors=${res.errors}`);
        for (const le of res.lineErrors) console.log(`      LINEERROR: ${le}`);
        if (!res.lineErrors.length) console.log(`      ${res.rawResponse.replace(/\s+/g, " ").slice(0, 220)}`);
      }
    } catch (e: any) { console.log(`   ✗ TRANSPORT: ${e.message}`); }
  }

  if (!PUSH) console.log(`\nDry run complete — nothing written. Add --push to send.`);
}

main().catch(e => { console.error(`✗ ${e.message}`); process.exit(1); });
