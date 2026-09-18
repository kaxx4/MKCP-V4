/**
 * Capability probe for the voucher types the proposed automations need but
 * which have never been pushed:
 *
 *   Receipt Note   — goods received, no invoice yet  → purchase-in-transit
 *   Delivery Note  — goods dispatched                → dispatch flow
 *   Contra         — cash ↔ bank                     → bank-screenshot OCR
 *   Journal        — adjustments
 *   Credit Note    — sales return
 *   Debit Note     — purchase return / supplier credit
 *
 * Pushes ONE type at a time and STOPS on the first transport-level failure,
 * because a malformed request freezes Tally and costs a restart.
 *
 *   npx tsx scripts/test-remaining-types.ts               # dry run
 *   npx tsx scripts/test-remaining-types.ts --push        # push, stop on failure
 *   npx tsx scripts/test-remaining-types.ts --push contra
 */
import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { convertCompanies } from "../src/converters/convert.js";
import { pushVoucherToTally, buildVoucherImportXml } from "../src/services/voucherPusher.js";
import { loadMasters } from "../src/services/tallyMasters.js";
import type { VoucherPayload } from "../src/types.js";

const TALLY_URL = process.env.TALLY_URL || "http://localhost:9000";
const args = process.argv.slice(2);
const PUSH = args.includes("--push");
const ONLY = args.filter(a => !a.startsWith("--")).flatMap(a => a.split(",")).map(s => s.trim().toLowerCase());

const TAG = `CAP${Date.now().toString().slice(-6)}`;
const TODAY = new Date().toISOString().slice(0, 10);

const CASH = "Cash";
const BANK = "HDFC BANK";
const GODOWN = "Main Location";
const BATCH = "Primary Batch";
const SALES_LEDGER = "SALES  ( GST W.B. )";
const PURCHASE_LEDGER = "PURCHASE  ( GST W.B. )";

const field = (b: string, t: string) => {
  const m = new RegExp(`<${t}[^>]*>([^<]*)</${t}>`).exec(b);
  return m ? m[1].trim()
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, "&") : "";
};
const numOf = (s: string) => parseFloat(s.replace(/[^\d.\-]/g, "")) || 0;

function coll(id: string, type: string, fields: string[], company: string) {
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>${id}</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${company}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="${id}" ISMODIFY="No"><TYPE>${type}</TYPE>
${fields.map(f => `<NATIVEMETHOD>${f}</NATIVEMETHOD>`).join("\n")}
</COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
}

async function main() {
  const company = convertCompanies(await tallyPost(TALLY_URL, HEALTH_XML, 10_000))[0]?.name;
  if (!company) throw new Error("No company loaded");
  console.log(`→ Company "${company}"\n→ Mode ${PUSH ? "PUSH (stops on first failure)" : "DRY RUN"}   Tag ${TAG}\n`);

  const ledgerXml: string = await tallyPost(TALLY_URL, coll("CapLed", "Ledger", ["Name", "Parent"], company), 180_000, true);
  const ledgers = [...ledgerXml.matchAll(/<LEDGER\b[^>]*>[\s\S]*?<\/LEDGER>/g)].map(m => m[0])
    .map(b => ({ name: field(b, "NAME"), parent: field(b, "PARENT") }));
  const debtor = ledgers.find(l => /SUNDRY DEBTORS/i.test(l.parent))!;
  const creditor = ledgers.find(l => /SUNDRY CREDITORS/i.test(l.parent))!;
  const expense = ledgers.find(l => /INDIRECT EXPENSES/i.test(l.parent)) ?? ledgers.find(l => /EXPENSES/i.test(l.parent))!;

  const itemXml: string = await tallyPost(TALLY_URL, coll("CapItem", "StockItem",
    ["Name", "BaseUnits", "ClosingBalance", "ClosingRate"], company), 180_000, true);
  const item = [...itemXml.matchAll(/<STOCKITEM\b[^>]*>[\s\S]*?<\/STOCKITEM>/g)].map(m => m[0])
    .map(b => ({ name: field(b, "NAME"), unit: field(b, "BASEUNITS") || "PC", rate: numOf(field(b, "CLOSINGRATE")), stock: numOf(field(b, "CLOSINGBALANCE")) }))
    .find(i => i.stock > 50 && i.rate > 20)!;

  console.log(`Using — debtor: ${debtor.name}\n        creditor: ${creditor.name}\n        expense: ${expense.name}\n        item: ${item.name} @ ${item.rate}/${item.unit}\n`);

  const inv = (isIn: boolean, ledger: string) => [{
    stockItemName: item.name, quantity: 2, unit: item.unit, rate: item.rate,
    amount: Math.round(2 * item.rate * 100) / 100,
    isDeemedPositive: isIn, salesLedgerName: ledger,
    godownName: GODOWN, batchName: BATCH,
  }];
  const amt = Math.round(2 * item.rate * 100) / 100;

  const cases: Record<string, VoucherPayload> = {
    // Goods received against a supplier, invoice not yet booked → in-transit landing
    "receipt note": {
      voucherType: "Receipt Note", date: TODAY, voucherNumber: `${TAG}/RN`,
      narration: `${TAG} goods received, invoice awaited`,
      partyLedgerName: creditor.name, isInvoice: false,
      ledgerEntries: [], inventoryEntries: inv(true, PURCHASE_LEDGER),
    },
    // Goods dispatched ahead of the invoice
    "delivery note": {
      voucherType: "Delivery Note", date: TODAY, voucherNumber: `${TAG}/DN`,
      narration: `${TAG} goods dispatched`,
      partyLedgerName: debtor.name, isInvoice: false,
      ledgerEntries: [], inventoryEntries: inv(false, SALES_LEDGER),
    },
    // Cash deposited into the bank — the shape a bank screenshot produces
    contra: {
      voucherType: "Journal", date: TODAY, voucherNumber: `${TAG}/C`,
      narration: `${TAG} CASH DEP`, partyLedgerName: BANK, isInvoice: false,
      ledgerEntries: [
        { ledgerName: BANK, amount: 5000, isDeemedPositive: true, isPartyLedger: false },
        { ledgerName: CASH, amount: 5000, isDeemedPositive: false, isPartyLedger: false },
      ],
    },
    journal: {
      voucherType: "Journal", date: TODAY, voucherNumber: `${TAG}/J`,
      narration: `${TAG} adjustment`, partyLedgerName: expense.name, isInvoice: false,
      ledgerEntries: [
        { ledgerName: expense.name, amount: 250, isDeemedPositive: true, isPartyLedger: false },
        { ledgerName: CASH, amount: 250, isDeemedPositive: false, isPartyLedger: false },
      ],
    },
    // Sales return — goods come back in
    "credit note": {
      voucherType: "Credit Note", date: TODAY, voucherNumber: `${TAG}/CN`,
      narration: `${TAG} sales return`, partyLedgerName: debtor.name, isInvoice: true,
      ledgerEntries: [{ ledgerName: debtor.name, amount: amt, isDeemedPositive: false, isPartyLedger: true }],
      inventoryEntries: inv(true, SALES_LEDGER),
    },
    // Purchase return / supplier credit
    "debit note": {
      voucherType: "Debit Note", date: TODAY, voucherNumber: `${TAG}/DBN`,
      narration: `${TAG} purchase return`, partyLedgerName: creditor.name, isInvoice: true,
      ledgerEntries: [{ ledgerName: creditor.name, amount: amt, isDeemedPositive: true, isPartyLedger: true }],
      inventoryEntries: inv(false, PURCHASE_LEDGER),
    },
  };

  const keys = ONLY.length ? ONLY : Object.keys(cases);
  const results: Array<[string, string]> = [];

  for (const k of keys) {
    const p = cases[k];
    if (!p) { console.log(`[${k}] unknown`); continue; }
    process.stdout.write(`[${k.padEnd(13)}] `);
    try { buildVoucherImportXml(company, p); }
    catch (e: any) { console.log(`✗ rejected locally: ${e.message}`); results.push([k, "local reject"]); continue; }

    if (!PUSH) { console.log("built OK (dry run)"); results.push([k, "built"]); continue; }

    try {
      const r = await pushVoucherToTally(TALLY_URL, company, p, await loadMasters(TALLY_URL, company));
      if (r.success) { console.log(`✓ created — id ${r.lastVoucherId}`); results.push([k, `created ${r.lastVoucherId}`]); }
      else {
        const why = r.lineErrors[0] ?? `exceptions in response`;
        console.log(`✗ rejected — ${why}`);
        results.push([k, `rejected: ${why}`]);
      }
    } catch (e: any) {
      console.log(`✗ TRANSPORT: ${e.message}`);
      console.log(`\n⚠ Stopping — Tally may now be showing a modal and need a restart.`);
      results.push([k, `transport: ${e.message}`]);
      break;
    }
  }

  console.log(`\n${"─".repeat(60)}\nCAPABILITY SUMMARY`);
  for (const [k, r] of results) console.log(`  ${k.padEnd(15)} ${r}`);
}

main().catch(e => { console.error(`✗ ${e.message}`); process.exit(1); });
