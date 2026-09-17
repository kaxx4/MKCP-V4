/**
 * Does a purchase land on the day we booked it, carrying the supplier's own
 * bill number and date?
 *
 * The owner's report: "the purchases are going to the wrong dates." The web
 * side of that was fixed on 17-Sep (a manifest was posting under the supplier's
 * date because `todayIso` was private to another module) — this asks the other
 * half of the question, which was never asked: given a payload with two
 * DIFFERENT dates in it, which one does Tally actually file the voucher under?
 *
 * The two dates are deliberately far apart so a mix-up cannot hide:
 *
 *   date           = today          the day the operator entered it
 *   referenceDate  = 16 days back   the day the supplier raised the bill
 *
 * Also checks the things a purchase carries that nothing has verified: the
 * supplier's bill number, the stock line's rate and quantity, the GST ledgers,
 * and whether an EFFECTIVEDATE appears that we never sent.
 *
 *   npx tsx scripts/fidelity/case-purchase.ts
 *   npx tsx scripts/fidelity/case-purchase.ts --keep
 */
import { tallyPost } from "../../src/tally.js";
import { pushVoucherToTally } from "../../src/services/voucherPusher.js";
import { loadMasters } from "../../src/services/tallyMasters.js";
import type { VoucherPayload } from "../../src/types.js";
import {
  U, MARK, company, vouchersOnDayXml, objects, fld, flds, block,
  check, checkNum, report, esc, importSummary,
} from "./harness.js";

const KEEP = process.argv.includes("--keep");

const iso = (d: Date) => d.toISOString().slice(0, 10);
const TODAY = iso(new Date());
const SUPPLIER_DATE = iso(new Date(Date.now() - 16 * 864e5));
const BILL_NO = `${MARK}/${Date.now().toString().slice(-5)}`;

async function main(): Promise<void> {
  const co = await company();
  const masters = await loadMasters(U, co);

  /* Real names from the company, never invented: a guessed ledger fails as
     "does not exist" and teaches nothing about dates. */
  const ledgers = [...masters.ledgers.values()];
  const items = [...masters.items.values()];
  const supplier = ledgers.find((l) => /TOGO CYCLES/i.test(l.name))
    ?? ledgers.find((l) => /Sundry Creditors/i.test(l.parent));
  /* A real purchase ACCOUNT, not a discount ledger: "PURCHASE DISCOUNTS ( @ 5% )"
     also starts with PURCHASE and picking it would test nothing useful. */
  const purchaseLedger = ledgers.find((l) => /^PURCHASE/i.test(l.name) && !/DISCOUNT/i.test(l.name))
    ?? ledgers.find((l) => /Purchase Accounts/i.test(l.parent));
  const item = items.find((i) => /HANDLE|CHAIN|TUBE/i.test(i.name)) ?? items[0];
  if (!supplier || !purchaseLedger || !item) {
    console.log("could not find a supplier / purchase ledger / item in this company");
    return;
  }

  const QTY = 10;
  const RATE = 100;
  const AMOUNT = QTY * RATE;

  console.log(`\ncompany        ${co}`);
  console.log(`supplier       ${supplier.name}`);
  console.log(`purchase a/c   ${purchaseLedger.name}`);
  console.log(`item           ${item.name}  (${item.baseUnit})`);
  console.log(`\nentry date     ${TODAY}        ← the voucher must file here`);
  console.log(`supplier date  ${SUPPLIER_DATE}        ← must appear only as the reference date`);
  console.log(`supplier bill  ${BILL_NO}\n`);

  const payload: VoucherPayload = {
    remoteId: `MKCP-PURCHASE-${BILL_NO}`,
    voucherType: "Purchase",
    date: TODAY,
    voucherNumber: BILL_NO,
    reference: BILL_NO,
    referenceDate: SUPPLIER_DATE,
    narration: `${MARK} purchase fidelity`,
    partyLedgerName: supplier.name,
    isInvoice: true,
    /* PARTY ONLY. In invoice mode the purchase ledger belongs in the stock
       line's accounting allocation and nowhere else — putting it here as well
       double-counts it, and the guard refuses the voucher saying so. That
       refusal is correct and it caught this payload on the first run. */
    ledgerEntries: [
      {
        ledgerName: supplier.name,
        amount: AMOUNT,
        isDeemedPositive: false,
        isPartyLedger: true,
        // The supplier's bill number becomes the bill reference a later
        // payment cites with Agst Ref. Verified below.
        billAllocations: [{ name: BILL_NO, billType: "New Ref", amount: AMOUNT }],
      },
    ],
    /* Mirrors engine/purchase/purchasePayload.ts exactly — the point is to test
       WHAT THE WEBSITE PUSHES, not a shape invented here. `salesLedgerName` is
       named for the sales case and carries the stock line's accounting
       allocation either way; a batch allocation is required or Tally rejects
       the whole voucher with EXCEPTIONS=1 and no error text. */
    inventoryEntries: [
      {
        stockItemName: item.name,
        quantity: QTY,
        unit: item.baseUnit,
        rate: RATE,
        amount: AMOUNT,
        isDeemedPositive: true,
        salesLedgerName: purchaseLedger.name,
        godownName: [...masters.godowns][0],
        batchName: "Primary Batch",
      },
    ],
  } as VoucherPayload;

  const res = await pushVoucherToTally(U, co, payload, masters);
  console.log(`   push: created=${res.created} altered=${res.altered} errors=${res.errors} exceptions=${(res as never as { exceptions?: number }).exceptions ?? "?"}`);
  if (res.lineErrors?.length) console.log(`   lineErrors: ${res.lineErrors.join(" | ")}`);

  // ── read back both days ───────────────────────────────────────────────────
  const onEntryDay = objects(
    (await tallyPost(U, vouchersOnDayXml(co, TODAY), 180_000, true)) as string, "VOUCHER");
  const onSupplierDay = objects(
    (await tallyPost(U, vouchersOnDayXml(co, SUPPLIER_DATE), 180_000, true)) as string, "VOUCHER");

  const byRef = (vs: { body: string }[]) =>
    vs.find((v) => fld(v.body, "VOUCHERNUMBER") === BILL_NO || fld(v.body, "REFERENCE") === BILL_NO);

  const here = byRef(onEntryDay);
  const there = byRef(onSupplierDay);

  const v = here ?? there;
  if (!v) {
    console.log(`\n   Not found on EITHER day. Nothing to compare.\n`);
    return;
  }

  const inv = block(v.body, "ALLINVENTORYENTRIES\\.LIST");
  const ledgerNames = flds(v.body, "LEDGERNAME");

  const checks = [
    check("filed on the entry date", "yes", here ? "yes" : "",
      { note: here ? undefined : `found on ${SUPPLIER_DATE} instead — the supplier's own date` }),
    check("not also on the supplier's date", "yes", there && here ? "" : "yes"),
    check("DATE", TODAY.replace(/-/g, ""), fld(v.body, "DATE")),
    check("REFERENCEDATE", SUPPLIER_DATE.replace(/-/g, ""), fld(v.body, "REFERENCEDATE")),
    check("REFERENCE (supplier bill no)", BILL_NO, fld(v.body, "REFERENCE")),
    check("EFFECTIVEDATE", TODAY.replace(/-/g, ""), fld(v.body, "EFFECTIVEDATE"),
      { note: "we never send this; checking what Tally defaults it to" }),
    check("party", supplier.name, fld(v.body, "PARTYLEDGERNAME")),
    check("voucher type", "Purchase", fld(v.body, "VOUCHERTYPENAME")),
    check("is invoice", "Yes", fld(v.body, "ISINVOICE")),
    check("narration", `${MARK} purchase fidelity`, fld(v.body, "NARRATION")),

    check("stock line present", "yes", inv ? "yes" : ""),
    check("  item", item.name, fld(inv, "STOCKITEMNAME")),
    checkNum("  quantity", QTY, fld(inv, "ACTUALQTY")),
    checkNum("  billed quantity", QTY, fld(inv, "BILLEDQTY")),
    checkNum("  rate", RATE, fld(inv, "RATE")),
    checkNum("  amount", AMOUNT, fld(inv, "AMOUNT").replace("-", "")),
    check("  accounting ledger", purchaseLedger.name, fld(block(inv, "ACCOUNTINGALLOCATIONS\\.LIST"), "LEDGERNAME")),

    check("party ledger on the voucher", "yes", ledgerNames.includes(supplier.name) ? "yes" : ""),
    check("bill ref name", BILL_NO, fld(block(v.body, "BILLALLOCATIONS\.LIST"), "NAME")),
    check("bill ref type", "New Ref", fld(block(v.body, "BILLALLOCATIONS\.LIST"), "BILLTYPE")),
    check("godown on the stock line", [...masters.godowns][0] ?? "",
      fld(block(inv, "BATCHALLOCATIONS\.LIST"), "GODOWNNAME")),
    check("batch on the stock line", "Primary Batch",
      fld(block(inv, "BATCHALLOCATIONS\.LIST"), "BATCHNAME")),
  ];

  const { failed } = report("purchase: intent vs what Tally stored", checks);

  if (KEEP) {
    console.log(`\n   --keep: ${BILL_NO} left in the books.\n`);
  } else {
    const del = (await tallyPost(U,
      `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Import</TALLYREQUEST><TYPE>Data</TYPE><ID>Vouchers</ID></HEADER>
<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${esc(co)}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC>
<REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER REMOTEID="${esc(payload.remoteId!)}" VCHTYPE="Purchase" ACTION="Delete"/></TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`,
      60_000, true)) as string;
    console.log(`   cleanup: ${importSummary(del)}`);
  }
  console.log("");
  if (failed) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
