/**
 * Sales: the tax head, the discount line, and the order that becomes an invoice.
 *
 * Four things nothing had verified end to end:
 *
 *   A  local sale        West Bengal party ⇒ CGST + SGST, `SALES ( GST W.B. )`
 *   B  interstate sale   Odisha party      ⇒ IGST, `SALES ( GST CENTRAL )`
 *   C  discount line     `TRADE DISCOUNTS / H.C.` is a NEGATIVE CREDIT — a
 *                        shape the usual sign-from-side rule cannot produce —
 *                        and it must appropriate to GST or Tally computes the
 *                        expected tax on the gross and files a mismatch
 *   D  order → invoice   a Sales Order Note ALTERED in place into a Sales
 *                        invoice on the same REMOTEID, keeping its MASTERID.
 *                        If it creates a second voucher instead, the goods are
 *                        counted twice.
 *
 * The tax head is the one that cannot be checked from the response: a voucher
 * with the wrong head balances, reads back byte-identical, and lands in the
 * wrong section of the return.
 */
import { tallyPost } from "../../src/tally.js";
import { pushVoucherToTally } from "../../src/services/voucherPusher.js";
import { loadMasters } from "../../src/services/tallyMasters.js";
import type { VoucherPayload } from "../../src/types.js";
import {
  U, MARK, company, vouchersOnDayXml, objects, fld, flds, block,
  check, checkNum, report, remember,
} from "./harness.js";

const TODAY = new Date().toISOString().slice(0, 10);
const tag = Date.now().toString().slice(-5);
const GODOWN = "Main Location";
const BATCH = "Primary Batch";

const r2 = (n: number) => Math.round(n * 100) / 100;

async function read(co: string, narration: string) {
  const vs = objects((await tallyPost(U, vouchersOnDayXml(co, TODAY), 180_000, true)) as string, "VOUCHER");
  return vs.find((v) => fld(v.body, "NARRATION") === narration);
}

async function main(): Promise<void> {
  const co = await company();
  const masters = await loadMasters(U, co);
  const L = [...masters.ledgers.values()];
  const items = [...masters.items.values()];

  const wb = L.find((l) => /Sundry Debtors/i.test(l.parent) && /west bengal/i.test(l.state))!;
  const out = L.find((l) => /Sundry Debtors/i.test(l.parent) && l.state && !/west bengal/i.test(l.state))!;
  const item = items.find((i) => /HANDLE|CHAIN/i.test(i.name)) ?? items[0];

  const QTY = 10, RATE = 100, TAXABLE = QTY * RATE;
  const results: { title: string; checks: ReturnType<typeof check>[] }[] = [];

  const stock = (ledger: string) => ([{
    stockItemName: item.name, quantity: QTY, unit: item.baseUnit, rate: RATE,
    amount: TAXABLE, isDeemedPositive: false, salesLedgerName: ledger,
    godownName: GODOWN, batchName: BATCH,
  }]);

  const sale = (
    n: string, party: string, salesLedger: string, gst: { ledger: string; amount: number }[],
    narration: string, extra: Record<string, unknown> = {},
  ): VoucherPayload => {
    const grand = r2(TAXABLE + gst.reduce((a, g) => a + g.amount, 0));
    return {
      remoteId: `MKCP-SALES-${n}`, voucherType: "Sales", date: TODAY, voucherNumber: n,
      narration, partyLedgerName: party, isInvoice: true,
      ledgerEntries: [
        { ledgerName: party, amount: grand, isDeemedPositive: true, isPartyLedger: true,
          billAllocations: [{ name: n, billType: "New Ref", amount: grand }] },
        ...gst.map((g) => ({ ledgerName: g.ledger, amount: g.amount, isDeemedPositive: false, isPartyLedger: false })),
      ],
      inventoryEntries: stock(salesLedger),
      ...extra,
    } as unknown as VoucherPayload;
  };

  // ── A: local ──────────────────────────────────────────────────────────────
  {
    const n = `${MARK}/SL${tag}`, narr = `${MARK} sales local`;
    const p = sale(n, wb.name, "SALES  ( GST W.B. )",
      [{ ledger: "OUTPUT CGST", amount: 25 }, { ledger: "OUTPUT SGST", amount: 25 }], narr);
    const res = await pushVoucherToTally(U, co, p, masters);
    remember({ remoteId: p.remoteId!, voucherType: "Sales", number: n, date: TODAY });
    const v = await read(co, narr);
    const names = v ? flds(v.body, "LEDGERNAME") : [];
    results.push({ title: `A — local sale to ${wb.name} (${wb.state})`, checks: [
      check("created", "1", String(res.created)),
      check("landed", "yes", v ? "yes" : ""),
      check("CGST on the voucher", "yes", v ? (names.includes("OUTPUT CGST") ? "yes" : "") : null),
      check("SGST on the voucher", "yes", v ? (names.includes("OUTPUT SGST") ? "yes" : "") : null),
      check("no IGST", "", v ? (names.includes("OUTPUT IGST") ? "IGST present" : "") : null),
      check("party GST identity block", wb.gstin || "(none)",
        v ? (fld(v.body, "PARTYGSTIN") || fld(block(v.body, "GSTREGISTRATIONDETAILS\\.LIST"), "GSTIN") || "") : null,
        { note: "without it the invoice files into a GSTR exception and no diff can see it" }),
      check("bill ref type", "New Ref", v ? fld(block(v.body, "BILLALLOCATIONS\\.LIST"), "BILLTYPE") : null),
      checkNum("stock qty outward", QTY, v ? fld(block(v.body, "ALLINVENTORYENTRIES\\.LIST"), "ACTUALQTY") : null),
    ]});
  }

  // ── B: interstate ─────────────────────────────────────────────────────────
  {
    const n = `${MARK}/SI${tag}`, narr = `${MARK} sales interstate`;
    const p = sale(n, out.name, "SALES  ( GST CENTRAL )", [{ ledger: "OUTPUT IGST", amount: 50 }], narr);
    const res = await pushVoucherToTally(U, co, p, masters);
    remember({ remoteId: p.remoteId!, voucherType: "Sales", number: n, date: TODAY });
    const v = await read(co, narr);
    const names = v ? flds(v.body, "LEDGERNAME") : [];
    results.push({ title: `B — interstate sale to ${out.name} (${out.state})`, checks: [
      check("created", "1", String(res.created)),
      check("IGST on the voucher", "yes", v ? (names.includes("OUTPUT IGST") ? "yes" : "") : null),
      check("no CGST/SGST", "", v ? (names.some((x) => /OUTPUT [CS]GST/.test(x)) ? "present" : "") : null),
      check("place of supply", out.state, v ? fld(v.body, "PLACEOFSUPPLY") : null),
    ]});
  }

  // ── C: with a discount line ───────────────────────────────────────────────
  {
    const n = `${MARK}/SD${tag}`, narr = `${MARK} sales discount`;
    const DISC = 40;
    const grand = r2(TAXABLE - DISC + 48);
    const p: VoucherPayload = {
      remoteId: `MKCP-SALES-${n}`, voucherType: "Sales", date: TODAY, voucherNumber: n,
      narration: narr, partyLedgerName: wb.name, isInvoice: true,
      ledgerEntries: [
        { ledgerName: wb.name, amount: grand, isDeemedPositive: true, isPartyLedger: true,
          billAllocations: [{ name: n, billType: "New Ref", amount: grand }] },
        { ledgerName: "TRADE DISCOUNTS / H.C.", amount: DISC, isDeemedPositive: false,
          signedAmount: -DISC, appropriateToGst: "Goods", isPartyLedger: false },
        { ledgerName: "OUTPUT CGST", amount: 24, isDeemedPositive: false, isPartyLedger: false },
        { ledgerName: "OUTPUT SGST", amount: 24, isDeemedPositive: false, isPartyLedger: false },
      ],
      inventoryEntries: stock("SALES  ( GST W.B. )"),
    } as unknown as VoucherPayload;
    const res = await pushVoucherToTally(U, co, p, masters);
    remember({ remoteId: p.remoteId!, voucherType: "Sales", number: n, date: TODAY });
    const v = await read(co, narr);
    const disc = v
      ? [...v.body.matchAll(/<ALLLEDGERENTRIES\.LIST>([\s\S]*?)<\/ALLLEDGERENTRIES\.LIST>/gi)]
          .map((m) => m[1]).find((b) => /TRADE DISCOUNTS/.test(fld(b, "LEDGERNAME")))
      : undefined;
    results.push({ title: "C — sale carrying a TRADE DISCOUNTS line", checks: [
      check("created", "1", String(res.created)),
      check("discount line present", "yes", v ? (disc ? "yes" : "") : null),
      check("  is a CREDIT (ISDEEMEDPOSITIVE=No)", "No", disc ? fld(disc, "ISDEEMEDPOSITIVE") : null),
      checkNum("  amount is NEGATIVE", -DISC, disc ? fld(disc, "AMOUNT") : null,
        { note: "a negative credit — the shape Tally itself writes on this company's 444 discount lines" }),
      check("  appropriates to GST", "Goods", disc ? fld(disc, "APPROPRIATEFOR") : null,
        { note: "without this Tally expects tax on the GROSS and files a GSTR-1 mismatch" }),
    ]});
  }

  // ── D: order → invoice on the same REMOTEID ───────────────────────────────
  {
    const n = `${MARK}/SO${tag}`, narr = `${MARK} order`;
    const rid = `MKCP-SALES-ORDER-NOTE-${n}`;
    const orderGrand = r2(TAXABLE + 50);
    const order: VoucherPayload = {
      remoteId: rid, voucherType: "Sales Order Note", date: TODAY, voucherNumber: n,
      narration: narr, partyLedgerName: wb.name, isInvoice: false,
      ledgerEntries: [
        { ledgerName: wb.name, amount: orderGrand, isDeemedPositive: true, isPartyLedger: true },
        { ledgerName: "OUTPUT CGST", amount: 25, isDeemedPositive: false, isPartyLedger: false },
        { ledgerName: "OUTPUT SGST", amount: 25, isDeemedPositive: false, isPartyLedger: false },
      ],
      inventoryEntries: stock("SALES  ( GST W.B. )"),
    } as unknown as VoucherPayload;
    const oRes = await pushVoucherToTally(U, co, order, masters);
    remember({ remoteId: rid, voucherType: "Sales Order Note", number: n, date: TODAY });
    const before = await read(co, narr);
    const masterBefore = before ? fld(before.body, "MASTERID") : "";

    const narr2 = `${MARK} order billed`;
    const invoice = {
      ...order, action: "Alter", voucherType: "Sales", isInvoice: true, narration: narr2,
    } as unknown as VoucherPayload;
    const iRes = await pushVoucherToTally(U, co, invoice, masters);
    const after = await read(co, narr2);
    const masterAfter = after ? fld(after.body, "MASTERID") : "";
    const still = await read(co, narr);

    results.push({ title: "D — Sales Order Note altered into a Sales invoice", checks: [
      check("order created", "1", String(oRes.created)),
      check("conversion ALTERED, not created", "altered",
        iRes.altered > 0 ? "altered" : iRes.created > 0 ? "created a SECOND voucher" : "neither"),
      check("same MASTERID kept", masterBefore || "?", masterAfter || "",
        { note: "a new id means the goods are now on two vouchers" }),
      check("it is a Sales invoice now", "Sales", after ? fld(after.body, "VOUCHERTYPENAME") : null),
      check("the order is gone", "", still ? "the order is STILL there as well" : ""),
    ]});
  }

  let failed = 0;
  for (const r of results) failed += report(r.title, r.checks).failed;
  console.log(`\n   sweep with scripts/fidelity/sweep.ts --delete\n`);
  if (failed) process.exitCode = 1;
}

main().catch((e) => { console.error("ERR:", e.message); process.exit(1); });
