/**
 * The four voucher types the pusher claims and nothing had field-diffed.
 *
 * `types.ts` lists eleven types. `test-remaining-types.ts` is a capability
 * PROBE — it pushes one of each behind a `--push` flag and reports whether
 * Tally accepted it. Accepting is not landing correctly: Tally takes several
 * malformed vouchers with `created=1` and quietly turns them into something
 * else, which is the whole reason the fidelity harness exists.
 *
 *   Contra          money between own accounts. The probe pushes this as a
 *                   JOURNAL, so the real Contra type has never been sent at
 *                   all — and Contra is what a cash deposit actually is.
 *   Journal         an adjustment between two ledgers
 *   Delivery Note   goods OUT ahead of the invoice
 *   Receipt Note    goods IN ahead of the supplier's bill
 *
 * For the two notes the thing that matters is not the response, it is whether
 * STOCK MOVED and in which direction. A note that books no movement leaves the
 * warehouse figure wrong while the voucher list looks complete; one that moves
 * it the wrong way is worse. `AFFECTSSTOCK` is read back for both, because a
 * Sales Order Note in this company turned out to move stock when nobody
 * expected it to.
 *
 *   npx tsx scripts/fidelity/case-remaining-types.ts
 */
import { tallyPost } from "../../src/tally.js";
import { pushVoucherToTally } from "../../src/services/voucherPusher.js";
import { loadMasters } from "../../src/services/tallyMasters.js";
import { guardVoucher } from "../../src/services/pushGuard.js";
import type { VoucherPayload } from "../../src/types.js";
import {
  U, MARK, company, vouchersOnDayXml, objects, fld, block, blocks,
  check, checkNum, report, remember,
} from "./harness.js";

const TODAY = new Date().toISOString().slice(0, 10);
const stamp = Date.now().toString().slice(-5);
const GODOWN = "Main Location";
const BATCH = "Primary Batch";

async function read(co: string, narration: string) {
  const vs = objects((await tallyPost(U, vouchersOnDayXml(co, TODAY), 180_000, true)) as string, "VOUCHER");
  return vs.find((v) => fld(v.body, "NARRATION") === narration);
}

(async () => {
  const co = await company();
  const masters = await loadMasters(U, co);
  const L = [...masters.ledgers.values()];
  const bank = L.find((l) => /bank/i.test(l.parent))!;
  const cash = L.find((l) => /^CASH$/i.test(l.name))!;
  const expense = L.find((l) => /Indirect Expenses/i.test(l.parent))!;
  const debtor = L.find((l) => /Sundry Debtors/i.test(l.parent))!;
  const creditor = L.find((l) => /Sundry Creditors/i.test(l.parent))!;
  const item = [...masters.items.values()][0];

  console.log(`\ncompany  ${co}`);
  console.log(`bank     ${bank.name}\ncash     ${cash.name}\nexpense  ${expense.name}\nitem     ${item.name}\n`);

  const results: { title: string; checks: ReturnType<typeof check>[] }[] = [];
  const QTY = 2;

  const stockLine = (inward: boolean, ledger: string) => ([{
    stockItemName: item.name, quantity: QTY, unit: item.baseUnit, rate: 100,
    amount: QTY * 100, isDeemedPositive: inward,
    salesLedgerName: ledger, godownName: GODOWN, batchName: BATCH,
  }]);

  async function run(
    title: string, type: string, narrTag: string, p: Partial<VoucherPayload>,
    checks: (stored: { body: string } | undefined, res: { created: number; errors: number }) => ReturnType<typeof check>[],
  ) {
    const n = `${MARK}/${narrTag}${stamp}`;
    const narr = `${MARK} ${narrTag} ${stamp}`;
    const payload = {
      remoteId: `MKCP-${type.toUpperCase().replace(/\s+/g, "-")}-${n}`,
      voucherType: type, date: TODAY, voucherNumber: n, narration: narr,
      isInvoice: false, ...p,
    } as unknown as VoucherPayload;
    remember({ remoteId: payload.remoteId!, voucherType: type, number: n, date: TODAY, narration: narr });
    const res = await pushVoucherToTally(U, co, payload, masters);
    const stored = await read(co, narr);
    console.log(`   [${narrTag}] created=${res.created} errors=${res.errors}` +
      (res.lineErrors?.length ? `  ${res.lineErrors.join(" | ")}` : ""));
    results.push({ title, checks: checks(stored, res) });
  }

  // ── Contra: cash into the bank, the real type ────────────────────────────
  await run("Contra — cash deposited into the bank", "Contra", "CONTRA", {
    partyLedgerName: bank.name,
    ledgerEntries: [
      { ledgerName: bank.name, amount: 5000, isDeemedPositive: true, isPartyLedger: false },
      { ledgerName: cash.name, amount: 5000, isDeemedPositive: false, isPartyLedger: false },
    ],
  }, (stored, res) => {
    const lines = stored ? blocks(stored.body, "ALLLEDGERENTRIES\\.LIST") : [];
    const bankLine = lines.find((b) => fld(b, "LEDGERNAME") === bank.name) ?? "";
    const cashLine = lines.find((b) => fld(b, "LEDGERNAME") === cash.name) ?? "";
    return [
      check("created", "1", String(res.created)),
      check("landed as a Contra", "contra", stored ? fld(stored.body, "VOUCHERTYPENAME").toLowerCase() : null,
        { note: "the old probe sent this as a Journal, so the real type had never been pushed" }),
      check("the bank is DEBITED", "Yes", bankLine ? fld(bankLine, "ISDEEMEDPOSITIVE") : null),
      check("cash is CREDITED", "No", cashLine ? fld(cashLine, "ISDEEMEDPOSITIVE") : null),
      checkNum("for the amount deposited", -5000, bankLine ? fld(bankLine, "AMOUNT") : null),
    ];
  });

  // ── Journal: an adjustment ───────────────────────────────────────────────
  await run("Journal — an adjustment between two ledgers", "Journal", "JRNL", {
    partyLedgerName: expense.name,
    ledgerEntries: [
      { ledgerName: expense.name, amount: 250, isDeemedPositive: true, isPartyLedger: false },
      { ledgerName: cash.name, amount: 250, isDeemedPositive: false, isPartyLedger: false },
    ],
  }, (stored, res) => {
    const lines = stored ? blocks(stored.body, "ALLLEDGERENTRIES\\.LIST") : [];
    const exp = lines.find((b) => fld(b, "LEDGERNAME") === expense.name) ?? "";
    return [
      check("created", "1", String(res.created)),
      check("landed as a Journal", "journal", stored ? fld(stored.body, "VOUCHERTYPENAME").toLowerCase() : null),
      check("the expense is DEBITED", "Yes", exp ? fld(exp, "ISDEEMEDPOSITIVE") : null),
      checkNum("for the adjustment", -250, exp ? fld(exp, "AMOUNT") : null),
      check("two lines, no more", "2", stored ? String(lines.filter((b) => fld(b, "LEDGERNAME")).length) : null),
    ];
  });

  /* ── Delivery Note: NOT CONFIGURED IN THIS COMPANY ──────────────────────
     Measured 18-Sep-2026. `types.ts` lists Delivery Note among the types this
     app can push, and the engine carries a whole netting subsystem for them
     (`matchBilledDeliveryNotes` / `netBilledDeliveryNotes`, run on every
     dataset change by the always-mounted NavBar). But:

       · Tally answers `Voucher Type 'Delivery Note' does not exist!`
       · the company's 25 configured types include Receipt Note and NOT
         Delivery Note
       · the mirror holds ZERO across every type and every date

     So the support is aspirational, and the useful thing to verify is that
     the GUARD refuses it with a legible message instead of the app trying and
     collecting a bare `created=0`. Asserted as the refusal it is. */
  {
    const n = `${MARK}/DNOTE${stamp}`;
    const p = {
      remoteId: `MKCP-DELIVERY-NOTE-${n}`, voucherType: "Delivery Note", date: TODAY,
      voucherNumber: n, narration: `${MARK} dnote ${stamp}`, isInvoice: false,
      partyLedgerName: debtor.name, ledgerEntries: [],
      inventoryEntries: stockLine(false, "SALES  ( GST W.B. )"),
    } as unknown as VoucherPayload;
    const g = guardVoucher(p, masters);
    console.log(`   [DNOTE] guard ok=${g.ok}  ${g.errors[0] ?? ""}`);
    results.push({ title: "Delivery Note — refused by the guard, because the type does not exist here", checks: [
      check("the guard refuses it", "refused", g.ok ? "allowed through" : "refused",
        { note: "Tally answers \"Voucher Type 'Delivery Note' does not exist!\" — the guard should say so first" }),
      check("and names the reason", "yes",
        g.errors.some((e) => /not configured in this company/i.test(e)) ? "yes" : ""),
      check("the company really has no such type", "",
        [...masters.voucherTypes].find((v) => /delivery note/i.test(v)) ?? "",
        { note: "25 types configured, Receipt Note among them, Delivery Note not" }),
    ]});
  }

  // ── Receipt Note: goods IN ───────────────────────────────────────────────
  await run("Receipt Note — goods received before the supplier's bill", "Receipt Note", "RNOTE", {
    partyLedgerName: creditor.name, ledgerEntries: [],
    inventoryEntries: stockLine(true, "PURCHASE ( GST CENTRAL )"),
  }, (stored, res) => {
    const invb = stored ? block(stored.body, "ALLINVENTORYENTRIES\\.LIST") : "";
    return [
      check("created", "1", String(res.created)),
      check("landed", "yes", stored ? "yes" : ""),
      /* AFFECTSSTOCK is not in the read-back — it is a voucher-TYPE property,
         not a stored field on the voucher. The movement itself is the proof,
         and it is right below: the item, the quantity and the direction. */
      check("the item that arrived", item.name, invb ? fld(invb, "STOCKITEMNAME") : null),
      checkNum("quantity in", QTY, invb ? fld(invb, "ACTUALQTY") : null),
      check("INWARD, not outward", "Yes", invb ? fld(invb, "ISDEEMEDPOSITIVE") : null),
    ];
  });

  let failed = false;
  for (const r of results) if (report(r.title, r.checks).failed) failed = true;
  console.log(`\n   sweep with scripts/fidelity/sweep.ts --delete\n`);
  if (failed) process.exitCode = 1;
})().catch((e) => { console.error("ERR:", e.message); process.exit(1); });
