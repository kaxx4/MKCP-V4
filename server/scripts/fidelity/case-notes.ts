/**
 * Credit Note, Debit Note, and a stock item master.
 *
 * Credit Note is numbered **Manual** in this company and Debit Note
 * **Automatic (Manual Override)** — so a number must be supplied for both, and
 * for the Credit Note there is no auto-numbering to fall back on at all.
 *
 * A credit note hands value BACK to the customer, so it CREDITS them — the
 * mirror of the sale it reverses. Getting that sign backwards produces a
 * voucher that balances and doubles the debt instead of clearing it.
 */
import { tallyPost } from "../../src/tally.js";
import { pushVoucherToTally } from "../../src/services/voucherPusher.js";
import { loadMasters } from "../../src/services/tallyMasters.js";
import type { VoucherPayload } from "../../src/types.js";
import {
  U, MARK, company, vouchersOnDayXml, allFieldsXml, objects, fld, block,
  check, checkNum, report, remember, push, esc, importSummary,
} from "./harness.js";

const TODAY = new Date().toISOString().slice(0, 10);
const t = Date.now().toString().slice(-5);
const GODOWN = "Main Location";
const BATCH = "Primary Batch";

async function read(co: string, n: string) {
  return objects((await tallyPost(U, vouchersOnDayXml(co, TODAY), 180_000, true)) as string, "VOUCHER")
    .find((v) => fld(v.body, "VOUCHERNUMBER") === n);
}

async function main(): Promise<void> {
  const co = await company();
  const masters = await loadMasters(U, co);
  const L = [...masters.ledgers.values()];
  const items = [...masters.items.values()];
  const customer = L.find((l) => /Sundry Debtors/i.test(l.parent) && /west bengal/i.test(l.state))!;
  const supplier = L.find((l) => /TOGO CYCLES/i.test(l.name))!;
  const item = items.find((i) => /BICYCLE/i.test(i.name)) ?? items[0];
  const results: { title: string; checks: ReturnType<typeof check>[] }[] = [];

  const QTY = 2, RATE = 100, TAXABLE = QTY * RATE;

  // ── Credit Note: goods coming BACK from a customer ────────────────────────
  {
    const n = `${MARK}/CN${t}`;
    const p: VoucherPayload = {
      remoteId: `MKCP-CREDIT-NOTE-${n}`, voucherType: "Credit Note", date: TODAY,
      voucherNumber: n, narration: `${MARK} credit note`, partyLedgerName: customer.name,
      isInvoice: true,
      ledgerEntries: [
        // CREDIT the customer — value handed back, the mirror of the sale.
        { ledgerName: customer.name, amount: TAXABLE + 10, isDeemedPositive: false, isPartyLedger: true },
        { ledgerName: "OUTPUT CGST", amount: 5, isDeemedPositive: true, isPartyLedger: false },
        { ledgerName: "OUTPUT SGST", amount: 5, isDeemedPositive: true, isPartyLedger: false },
      ],
      inventoryEntries: [{
        stockItemName: item.name, quantity: QTY, unit: item.baseUnit, rate: RATE, amount: TAXABLE,
        // Inward: the goods are coming back to us.
        isDeemedPositive: true, salesLedgerName: "SALES  ( GST W.B. )",
        godownName: GODOWN, batchName: BATCH,
      }],
    } as unknown as VoucherPayload;
    const res = await pushVoucherToTally(U, co, p, masters);
    remember({ remoteId: p.remoteId!, voucherType: "Credit Note", number: n, date: TODAY });
    const v = await read(co, n);
    const party = v
      ? [...v.body.matchAll(/<(?:ALL)?LEDGERENTRIES\.LIST>([\s\S]*?)<\/(?:ALL)?LEDGERENTRIES\.LIST>/gi)]
          .map((m) => m[1]).find((b) => fld(b, "LEDGERNAME") === customer.name)
      : undefined;
    results.push({ title: "Credit Note — goods back from a customer", checks: [
      check("created", "1", String(res.created),
        { note: res.lineErrors?.join(" | ") || undefined }),
      check("landed", "yes", v ? "yes" : ""),
      check("type", "Credit Note", v ? fld(v.body, "VOUCHERTYPENAME") : null),
      check("number kept (this type is MANUAL)", n, v ? fld(v.body, "VOUCHERNUMBER") : null),
      check("customer is CREDITED", "No", party ? fld(party, "ISDEEMEDPOSITIVE") : null,
        { note: "Yes here would DOUBLE the debt instead of clearing it" }),
      checkNum("stock comes back in", QTY, v ? fld(block(v.body, "ALLINVENTORYENTRIES\\.LIST"), "ACTUALQTY") : null),
    ]});
  }

  // ── Debit Note: goods going BACK to a supplier ────────────────────────────
  {
    const n = `${MARK}/DN${t}`;
    const p: VoucherPayload = {
      remoteId: `MKCP-DEBIT-NOTE-${n}`, voucherType: "Debit Note", date: TODAY,
      voucherNumber: n, narration: `${MARK} debit note`, partyLedgerName: supplier.name,
      isInvoice: true,
      ledgerEntries: [
        // DEBIT the supplier — they owe us back.
        { ledgerName: supplier.name, amount: TAXABLE, isDeemedPositive: true, isPartyLedger: true },
      ],
      inventoryEntries: [{
        stockItemName: item.name, quantity: QTY, unit: item.baseUnit, rate: RATE, amount: TAXABLE,
        isDeemedPositive: false, salesLedgerName: "PURCHASE ( GST CENTRAL )",
        godownName: GODOWN, batchName: BATCH,
      }],
    } as unknown as VoucherPayload;
    const res = await pushVoucherToTally(U, co, p, masters);
    remember({ remoteId: p.remoteId!, voucherType: "Debit Note", number: n, date: TODAY });
    const v = await read(co, n);
    const party = v
      ? [...v.body.matchAll(/<(?:ALL)?LEDGERENTRIES\.LIST>([\s\S]*?)<\/(?:ALL)?LEDGERENTRIES\.LIST>/gi)]
          .map((m) => m[1]).find((b) => fld(b, "LEDGERNAME") === supplier.name)
      : undefined;
    results.push({ title: "Debit Note — goods back to a supplier", checks: [
      check("created", "1", String(res.created),
        { note: res.lineErrors?.join(" | ") || undefined }),
      check("type", "Debit Note", v ? fld(v.body, "VOUCHERTYPENAME") : null),
      check("supplier is DEBITED", "Yes", party ? fld(party, "ISDEEMEDPOSITIVE") : null),
      checkNum("stock goes out", QTY, v ? fld(block(v.body, "ALLINVENTORYENTRIES\\.LIST"), "ACTUALQTY") : null),
    ]});
  }

  // ── A stock item master ───────────────────────────────────────────────────
  {
    const name = `${MARK} ITEM ${t}`;
    /* Built inline because `masterPusher` has no item builder at all — it
       exports `createLedger` and `deleteLedger` and nothing else. Tally itself
       accepts a stock item over XML; the APP cannot make one, which matters
       the first time a bill arrives with a part nobody has set up. */
    const xml = `<STOCKITEM NAME="${esc(name)}" ACTION="Create">
      <NAME>${esc(name)}</NAME>
      <PARENT>${esc(item.parent || "Primary")}</PARENT>
      <BASEUNITS>${esc(item.baseUnit)}</BASEUNITS>
      <ISBATCHWISEON>No</ISBATCHWISEON>
      <ISPERISHABLEON>No</ISPERISHABLEON>
      <ISCOSTCENTRESON>No</ISCOSTCENTRESON>
    </STOCKITEM>`;
    const res = await push(co, xml, "create item");
    const dump = (await tallyPost(U, allFieldsXml(co, "StockItem"), 180_000, true)) as string;
    const mine = objects(dump, "STOCKITEM").find((x) => x.name === name);
    results.push({ title: "Stock item master", checks: [
      check("created", "1", String(/<CREATED>(\d+)/.exec(res)?.[1] ?? "0")),
      check("found on read-back", "yes", mine ? "yes" : ""),
      check("base unit", item.baseUnit, mine ? fld(mine.body, "BASEUNITS") : null),
      check("parent group", item.parent || "Primary", mine ? fld(mine.body, "PARENT") : null),
    ]});
    if (mine) {
      const del = await push(co,
        `<STOCKITEM NAME="${esc(name)}" ACTION="Delete"><NAME>${esc(name)}</NAME></STOCKITEM>`, "delete item");
      console.log(`   item cleanup: ${importSummary(del)}`);
    }
  }

  let failed = 0;
  for (const r of results) failed += report(r.title, r.checks).failed;
  console.log(`\n   sweep with scripts/fidelity/sweep.ts --delete\n`);
  if (failed) process.exitCode = 1;
}

main().catch((e) => { console.error("ERR:", e.message); process.exit(1); });
