/**
 * Auto-inferring push-to-Tally test harness — no manual ledger/item setup
 * required. Connects to whatever company is currently loaded in Tally, pulls
 * its real ledgers + stock items (same Collection XML the production sync
 * uses), infers a party/supplier/sales/purchase/cash ledger and one stock
 * item from what's actually there, then builds and (optionally) pushes one
 * sample Sales / Purchase / Payment / Receipt voucher — all clearly tagged
 * "MKCP-TEST" in the reference/narration so they're easy to find and delete.
 *
 * SAFE BY DEFAULT: running with no flags only CONNECTS + INFERS + PRINTS.
 * Nothing is written to Tally unless you pass --push.
 *
 * Usage (from server/):
 *   npx tsx scripts/test-push-vouchers.ts                  # dry run: show what it found + would push
 *   npx tsx scripts/test-push-vouchers.ts --push            # actually push all 4 sample vouchers
 *   npx tsx scripts/test-push-vouchers.ts --push sales,purchase
 *   npx tsx scripts/test-push-vouchers.ts --company "M.K.CYCLES (Duplicate)" --push
 */
import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { buildCollectionXml } from "../src/services/xmlBuilder.js";
import { convertCompanies, convertLedgers, convertStockItems } from "../src/converters/convert.js";
import { MASTER_COLLECTIONS } from "../src/config/collections.js";
import { pushVoucherToTally } from "../src/services/voucherPusher.js";
import type { VoucherPayload } from "../src/types.js";

const TALLY_URL = process.env.TALLY_URL || "http://localhost:9000";

const rawArgs = process.argv.slice(2);
const PUSH = rawArgs.includes("--push");
const companyFlagIdx = rawArgs.indexOf("--company");
const COMPANY_OVERRIDE = companyFlagIdx >= 0 ? rawArgs[companyFlagIdx + 1] : undefined;
const typesArg = rawArgs.find(a => !a.startsWith("--") && a !== COMPANY_OVERRIDE);
const ONLY = (typesArg || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

const TAG = `MKCP-TEST-${Date.now().toString().slice(-6)}`;
const TODAY = new Date().toISOString().slice(0, 10);

type Ledger = { name: string; parent: string };
type StockItem = { name: string; parent: string; baseunits: string };

function has(parent: string, ...keywords: string[]): boolean {
  const p = parent.toUpperCase();
  return keywords.some(k => p.includes(k.toUpperCase()));
}

async function getCurrentCompany(): Promise<string> {
  if (COMPANY_OVERRIDE) return COMPANY_OVERRIDE;
  const parsed = await tallyPost(TALLY_URL, HEALTH_XML, 10_000);
  const companies = convertCompanies(parsed);
  if (companies.length === 0) throw new Error("No company loaded in Tally (List of Companies returned empty)");
  return companies[0].name;
}

async function getLedgers(company: string): Promise<Ledger[]> {
  const def = MASTER_COLLECTIONS.find(c => c.name === "ledgers")!;
  const xml = buildCollectionXml(def, company);
  const parsed = await tallyPost(TALLY_URL, xml, def.timeout);
  return convertLedgers(parsed).tallymessage as Ledger[];
}

async function getStockItems(company: string): Promise<StockItem[]> {
  const def = MASTER_COLLECTIONS.find(c => c.name === "stockItems")!;
  const xml = buildCollectionXml(def, company);
  const parsed = await tallyPost(TALLY_URL, xml, def.timeout);
  return convertStockItems(parsed).tallymessage as StockItem[];
}

/** Pick the best-matching ledger for a role, or null if nothing qualifies. */
function pickLedger(ledgers: Ledger[], ...keywords: string[]): Ledger | null {
  return ledgers.find(l => has(l.parent, ...keywords)) ?? null;
}

function inferCash(ledgers: Ledger[]): Ledger | null {
  return (
    ledgers.find(l => l.name.trim().toUpperCase() === "CASH") ??
    pickLedger(ledgers, "CASH-IN-HAND") ??
    pickLedger(ledgers, "BANK ACCOUNTS", "BANK OD")
  );
}

async function main() {
  console.log(`→ Tally: ${TALLY_URL}`);
  const company = await getCurrentCompany();
  console.log(`→ Company (auto-detected): "${company}"${COMPANY_OVERRIDE ? " (override)" : ""}`);
  console.log(`→ Mode: ${PUSH ? "PUSH (will write to Tally)" : "DRY RUN (inference only, nothing written)"}`);
  console.log(`→ Tag: ${TAG}\n`);

  console.log("Pulling ledgers + stock items…");
  const [ledgers, items] = await Promise.all([getLedgers(company), getStockItems(company)]);
  console.log(`  ${ledgers.length} ledgers, ${items.length} stock items\n`);

  const party = pickLedger(ledgers, "SUNDRY DEBTORS");
  const supplier = pickLedger(ledgers, "SUNDRY CREDITORS");
  const salesLedger = pickLedger(ledgers, "SALES ACCOUNTS") ?? ledgers.find(l => has(l.name, "SALES"));
  const purchaseLedger = pickLedger(ledgers, "PURCHASE ACCOUNTS") ?? ledgers.find(l => has(l.name, "PURCHASE"));
  const cash = inferCash(ledgers);
  const item = items.find(i => i.baseunits && i.baseunits.trim()) ?? items[0] ?? null;

  console.log("Inferred:");
  console.log(`  party (Sundry Debtor)    : ${party?.name ?? "✗ NOT FOUND"}`);
  console.log(`  supplier (Sundry Creditor): ${supplier?.name ?? "✗ NOT FOUND"}`);
  console.log(`  sales ledger             : ${salesLedger?.name ?? "✗ NOT FOUND"}`);
  console.log(`  purchase ledger          : ${purchaseLedger?.name ?? "✗ NOT FOUND"}`);
  console.log(`  cash/bank ledger         : ${cash?.name ?? "✗ NOT FOUND"}`);
  console.log(`  stock item               : ${item ? `${item.name} (unit: ${item.baseunits})` : "✗ NOT FOUND"}\n`);

  const samples: Record<string, VoucherPayload | null> = {
    sales: party && salesLedger && item ? {
      voucherType: "Sales",
      date: TODAY,
      voucherNumber: `${TAG}-S`,
      reference: `${TAG}-SALES`,
      narration: `${TAG} — automated push test, safe to delete`,
      partyLedgerName: party.name,
      isInvoice: true,
      ledgerEntries: [
        // Party only — the sales ledger rides in the inventory line's
        // accounting allocation. Listing it here too double-counts the credit
        // side and Tally rejects the voucher.
        { ledgerName: party.name, amount: 100, isDeemedPositive: true, isPartyLedger: true, billAllocations: [{ name: `${TAG}-SALES`, billType: "New Ref", amount: 100 }] },
      ],
      inventoryEntries: [
        { stockItemName: item.name, quantity: 1, unit: item.baseunits, rate: 100, amount: 100, isDeemedPositive: false, salesLedgerName: salesLedger.name, godownName: "Main Location" },
      ],
    } : null,

    purchase: supplier && purchaseLedger && item ? {
      voucherType: "Purchase",
      date: TODAY,
      voucherNumber: `${TAG}-P`,
      reference: `${TAG}-PUR`,
      narration: `${TAG} — automated push test, safe to delete`,
      partyLedgerName: supplier.name,
      isInvoice: true,
      ledgerEntries: [
        { ledgerName: supplier.name, amount: 100, isDeemedPositive: false, isPartyLedger: true, billAllocations: [{ name: `${TAG}-PUR`, billType: "New Ref", amount: 100 }] },
      ],
      inventoryEntries: [
        { stockItemName: item.name, quantity: 1, unit: item.baseunits, rate: 100, amount: 100, isDeemedPositive: true, salesLedgerName: purchaseLedger.name, godownName: "Main Location" },
      ],
    } : null,

    payment: supplier && cash ? {
      voucherType: "Payment",
      date: TODAY,
      voucherNumber: `${TAG}-PY`,
      narration: `${TAG} — automated push test, safe to delete`,
      partyLedgerName: supplier.name,
      isInvoice: false,
      ledgerEntries: [
        { ledgerName: supplier.name, amount: 100, isDeemedPositive: true, isPartyLedger: true, billAllocations: [{ name: `${TAG}-PAY`, billType: "On Account", amount: 100 }] },
        { ledgerName: cash.name, amount: 100, isDeemedPositive: false, isPartyLedger: false },
      ],
    } : null,

    receipt: party && cash ? {
      voucherType: "Receipt",
      date: TODAY,
      voucherNumber: `${TAG}-R`,
      narration: `${TAG} — automated push test, safe to delete`,
      partyLedgerName: party.name,
      isInvoice: false,
      ledgerEntries: [
        { ledgerName: cash.name, amount: 100, isDeemedPositive: true, isPartyLedger: false },
        { ledgerName: party.name, amount: 100, isDeemedPositive: false, isPartyLedger: true },
      ],
    } : null,
  };

  const keys = ONLY.length > 0 ? ONLY : Object.keys(samples);

  for (const key of keys) {
    const payload = samples[key];
    if (payload === undefined) {
      console.log(`⚠ Skipping unknown voucher key "${key}" (known: ${Object.keys(samples).join(", ")})`);
      continue;
    }
    if (payload === null) {
      console.log(`[${key.padEnd(9)}] ⏭ skipped — missing a required ledger/item (see Inferred list above)`);
      continue;
    }
    if (!PUSH) {
      console.log(`[${key.padEnd(9)}] would push: ${payload.partyLedgerName}, amount 100 (dry run — pass --push to actually write)`);
      continue;
    }
    process.stdout.write(`[${key.padEnd(9)}] pushing… `);
    try {
      const result = await pushVoucherToTally(TALLY_URL, company, payload);
      if (result.success) {
        console.log(`✓ created (voucher id ${result.lastVoucherId})`);
      } else {
        console.log(`✗ FAILED — created=${result.created} errors=${result.errors}`);
        for (const le of result.lineErrors) console.log(`    LINEERROR: ${le}`);
        if (result.lineErrors.length === 0) console.log(`    raw: ${result.rawResponse.slice(0, 500)}`);
      }
    } catch (e: any) {
      console.log(`✗ EXCEPTION: ${e.message}`);
    }
  }

  if (!PUSH) console.log(`\nDry run only — nothing written. Re-run with --push once this looks right.`);
}

main().catch(e => {
  console.error(`✗ ${e.message}`);
  process.exit(1);
});
