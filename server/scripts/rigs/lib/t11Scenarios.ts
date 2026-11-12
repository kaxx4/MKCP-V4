/**
 * JOB: the exact vouchers each first-priority T11 rig sends, as pure data (no Tally, no clock, no randomness),
 * so the offline test can run every one through the push guard, the XML builder and the balance check before
 * the rig is allowed near the dummy.
 *
 *   C23  purchase with items Tally lacks: the refusal, then the items, then the purchase
 *   C25  a truck run of 4 notes converted after Process (discount and freight on TRADE DISCOUNTS / H.C.)
 *   C26  one note split into cash bills and a ledger bill
 *   C26b the split's edges: refusals (limit, no buyer, wrong state) and one line's quantity shared across bills
 *   C29  a freight bill under reverse charge, its tax journal and its payment
 *
 * C22 (Stock Journal) lives in t11StockJournal.ts because it needs the new builder.
 */
import type { VoucherPayload } from "../../../src/types.js";
import {
  buildBillPayment, buildFreightBill, buildPurchase, buildRcmJournals, buildSale, r2, saleTotals,
  zzItems, zzNarration, zzNumber, zzParties, zzRemoteId, type Kit, type Line, type ZzItem, type ZzParty,
} from "./t11Kit.js";

const lineOf = (it: ZzItem, qty: number, rate: number): Line => ({ item: it.name, unit: it.baseUnit, qty, rate, gstRate: it.gstRate });

// ── C23 ───────────────────────────────────────────────────────────────────────
export function c23(stamp: string, day: string, kit: Kit) {
  const parties = zzParties(stamp);
  const [a, b] = zzItems(stamp, kit);
  const number = zzNumber(stamp, "P1");
  const mk = (n: string, lines: Line[]): VoucherPayload => buildPurchase({
    kit, number: n, date: day, narration: zzNarration(stamp, "purchase with new items"),
    supplier: parties.supplier, supplierInvoice: `ZZB${stamp}/${n.slice(-2)}`, inter: true, lines,
  });
  return {
    parties, items: [a, b],
    /** Sent BEFORE the items exist: the guard must refuse it and nothing may reach Tally. */
    beforeItems: mk(zzNumber(stamp, "P0"), [lineOf(a, 10, 100), lineOf(b, 20, 50)]),
    /** Sent after the items are made. */
    purchase: mk(number, [lineOf(a, 10, 100), lineOf(b, 20, 50)]),
    /** Items a purchase brings in: item name -> quantity. */
    expectedStock: new Map<string, number>([[a.name, 10], [b.name, 20]]),
  };
}

// ── C25 ───────────────────────────────────────────────────────────────────────
export interface TruckNote { tag: string; party: ZzParty; inter: boolean; lines: Line[]; discount: number; freight: number }
export function c25(stamp: string, day: string, kit: Kit) {
  const parties = zzParties(stamp);
  const [a, b] = zzItems(stamp, kit);
  const notes: TruckNote[] = [
    { tag: "T1", party: parties.local, inter: false, lines: [lineOf(a, 10, 100), lineOf(b, 20, 50)], discount: 40, freight: 0 },
    { tag: "T2", party: parties.local, inter: false, lines: [lineOf(a, 5, 100)], discount: 0, freight: 150 },
    { tag: "T3", party: parties.inter, inter: true, lines: [lineOf(a, 8, 100), lineOf(b, 10, 50)], discount: 100, freight: 60 },
    { tag: "T4", party: parties.local, inter: false, lines: [lineOf(b, 30, 50)], discount: 20, freight: 120 },
  ];
  const note = (t: TruckNote): VoucherPayload => buildSale({
    kit, type: "Sales Order Note", number: zzNumber(stamp, t.tag), date: day,
    narration: zzNarration(stamp, `truck note ${t.tag}`), party: t.party, inter: t.inter, lines: t.lines,
  });
  /** After Process: the same voucher (same REMOTEID, same number), now a Sales invoice carrying discount and freight. */
  const invoice = (t: TruckNote): VoucherPayload => buildSale({
    kit, type: "Sales", number: zzNumber(stamp, t.tag), date: day, action: "Alter",
    remoteId: zzRemoteId("SALES ORDER NOTE", zzNumber(stamp, t.tag)),
    narration: zzNarration(stamp, `truck invoice ${t.tag}`), party: t.party, inter: t.inter, lines: t.lines,
    discount: t.discount, freight: t.freight,
  });
  return { parties, items: [a, b], notes, noteOf: note, invoiceOf: invoice };
}

// ── C26 / C26b ────────────────────────────────────────────────────────────────
export interface SplitPlan {
  note: VoucherPayload;
  ledgerBill: VoucherPayload;
  cashBills: VoucherPayload[];
  /** Taxable value of the whole note, and the tax on it worked line by line. */
  whole: { taxable: number; tax: number };
}

export function c26(stamp: string, day: string, kit: Kit): SplitPlan & { parties: ReturnType<typeof zzParties>; items: ZzItem[] } {
  const parties = zzParties(stamp);
  const [a, b] = zzItems(stamp, kit);
  const L = [lineOf(a, 10, 100), lineOf(b, 20, 50), lineOf(a, 3, 100), lineOf(b, 7, 50), lineOf(a, 2, 100), lineOf(b, 1, 50)];
  const note = buildSale({ kit, type: "Sales Order Note", number: zzNumber(stamp, "X0"), date: day, narration: zzNarration(stamp, "split note"), party: parties.local, lines: L });
  /* The note becomes the ledger bill (Alter keeps one voucher): lines 1 and 2. */
  const ledgerBill = buildSale({
    kit, type: "Sales", number: zzNumber(stamp, "X0"), date: day, action: "Alter", remoteId: zzRemoteId("SALES ORDER NOTE", zzNumber(stamp, "X0")),
    narration: zzNarration(stamp, "split ledger bill"), party: parties.local, lines: L.slice(0, 2),
  });
  const cash = (tag: string, lines: Line[], buyer: string): VoucherPayload => buildSale({
    kit, type: "Sales", number: zzNumber(stamp, tag), date: day, narration: zzNarration(stamp, `split cash bill ${tag}`),
    party: { name: kit.cash }, lines, walkIn: { name: buyer, address: ["ZZ TEST BUYER ROAD", "KOLKATA 700003"] },
  });
  const cashBills = [cash("X1", L.slice(2, 4), `ZZ TEST BUYER ONE ${stamp}`), cash("X2", L.slice(4, 6), `ZZ TEST BUYER TWO ${stamp}`)];
  // The whole note worked per rate on the full value (the figure the bills must add back to).
  const taxableWhole = r2(L.reduce((s, l) => s + l.qty * l.rate, 0));
  const taxWhole = r2(L.reduce((s, l) => s + l.qty * l.rate * l.gstRate / 100, 0));
  return { parties, items: [a, b], note, ledgerBill, cashBills, whole: { taxable: taxableWhole, tax: taxWhole } };
}

export function c26b(stamp: string, day: string, kit: Kit) {
  const parties = zzParties(stamp);
  const [a, b] = zzItems(stamp, kit);
  const cash = (tag: string, lines: Line[], over: { buyer?: string; inter?: boolean } = {}): VoucherPayload => {
    const p = buildSale({
      kit, type: "Sales", number: zzNumber(stamp, tag), date: day, narration: zzNarration(stamp, `split edge ${tag}`),
      party: { name: kit.cash }, lines, inter: over.inter,
      walkIn: { name: over.buyer ?? `ZZ TEST BUYER ${tag} ${stamp}`, address: ["ZZ TEST BUYER ROAD", "KOLKATA 700003"] },
    });
    return over.buyer === "" ? { ...p, buyerName: "" } as VoucherPayload : p;
  };
  return {
    parties, items: [a, b],
    /** Goods over the Rs 50,000 cash limit: refused outright. */
    overLimit: cash("E1", [lineOf(a, 600, 100)]),
    /** No buyer name: refused. */
    noBuyer: cash("E2", [lineOf(a, 2, 100)], { buyer: "" }),
    /** Interstate on a walk-in: place of supply must be West Bengal, refused. */
    wrongState: cash("E3", [lineOf(a, 2, 100)], { inter: true }),
    /** One line's quantity shared across two cash bills (6 + 4 of 10): the taxable and tax must add back to the whole line. */
    shareA: cash("E4", [lineOf(a, 6, 33.33)]),
    shareB: cash("E5", [lineOf(a, 4, 33.33)]),
    wholeLine: { taxable: r2(10 * 33.33), tax: r2(10 * 33.33 * 18 / 100) },
  };
}

// ── C29 ───────────────────────────────────────────────────────────────────────
export function c29(stamp: string, day: string, kit: Kit) {
  const parties = zzParties(stamp);
  const amount = 41500;
  const billNo = `ZZB${stamp}`;
  const bill = buildFreightBill({ kit, number: zzNumber(stamp, "F1"), date: day, narration: zzNarration(stamp, "freight bill under RCM"), carrier: parties.transport, billNo, amount });
  const rcm = buildRcmJournals({ kit, numberIncrease: zzNumber(stamp, "F2"), numberDecrease: zzNumber(stamp, "F4"), date: day, narration: zzNarration(stamp, "BEING GST UNDER RCM"), taxable: amount, rate: 5 });
  const pay = buildBillPayment({ kit, number: zzNumber(stamp, "F3"), date: day, narration: zzNarration(stamp, "freight bill paid"), party: parties.transport, billName: billNo, amount });
  return { parties, bill, tax: rcm.increase, taxDecrease: rcm.decrease, pay, billNo, amount, rcmTax: r2(amount * 5 / 100) };
}

export { saleTotals };
