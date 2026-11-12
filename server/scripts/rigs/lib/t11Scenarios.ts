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

// ── C26R (D-M.203): split cash bills settled with Sell's new rounding ────────────────────────────────────────────────
/**
 * A copy of Sell's `settleWholeRupees` (web lane/sell 8bcedde1, engine/cashInvoice.ts), kept here only as the rig's oracle: the bills of one
 * order add up to the order's rounded total T, and each bill is the floor or the ceiling of its own exact total; the bills with the largest
 * paise go up, a tie to the earlier bill. The rig never uses it to decide what Tally should hold, only to build the bills Sell's code would send.
 */
export function settleWholeRupeesOracle(exactTotals: readonly number[]): number[] {
  const paise = exactTotals.map((e) => Math.round(r2(e) * 100));
  const out = paise.map((p) => Math.floor(p / 100));
  const target = Math.round(paise.reduce((s, p) => s + p, 0) / 100);
  let extra = target - out.reduce((s, g) => s + g, 0);
  const order = paise.map((p, i) => ({ i, frac: p - out[i]! * 100 })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const r of order) { if (extra <= 0) break; out[r.i]! += 1; extra -= 1; }
  return out;
}

/** A one-line bill whose exact total ends in exactly `paiseEnd` paise (tax worked as buildSale works it). */
function rateEndingIn(it: ZzItem, paiseEnd: number, from: number): { rate: number; exact: number } {
  for (let c = Math.round(from * 100); c < Math.round(from * 100) + 100000; c++) {
    const rate = c / 100;
    const half = r2(rate * it.gstRate / 200), exact = r2(rate + 2 * half);
    if (Math.round(exact * 100) % 100 === paiseEnd) return { rate, exact };
  }
  throw new Error(`no rate found for ${it.name} ending in ${paiseEnd} paise`);
}

export interface RoundCase { id: string; label: string; ends: number[]; bills: VoucherPayload[]; exacts: number[]; settled: number[]; orderTotal: number }

export function c26r(stamp: string, day: string, kit: Kit): { items: ZzItem[]; cases: RoundCase[] } {
  const [a, b] = zzItems(stamp, kit);
  const mk = (id: string, label: string, ends: number[]): RoundCase => {
    const picked = ends.map((e, i) => rateEndingIn(i % 2 === 0 ? b : a, e, 20 + i * 7));
    const exacts = picked.map((p) => p.exact);
    const settled = settleWholeRupeesOracle(exacts);
    const bills = picked.map((p, i) => buildSale({
      kit, type: "Sales", number: zzNumber(stamp, `${id}${i + 1}`), date: day, narration: zzNarration(stamp, `rounding ${id} bill ${i + 1}`),
      party: { name: kit.cash }, lines: [lineOf(i % 2 === 0 ? b : a, 1, p.rate)], settledGrand: settled[i],
      walkIn: { name: `ZZ TEST BUYER ${id}${i + 1} ${stamp}`, address: ["ZZ TEST BUYER ROAD", "KOLKATA 700003"] },
    }));
    return { id, label, ends, bills, exacts, settled, orderTotal: Math.round(r2(exacts.reduce((s, e) => s + e, 0))) };
  };
  return {
    items: [a, b],
    cases: [
      mk("Q1", "three bills that each end .50", [50, 50, 50]),
      mk("Q2", "two bills that each end .26 (one round-off of about +0.74)", [26, 26]),
      mk("Q3", "four bills ending .30, .70, .50, .50", [30, 70, 50, 50]),
    ],
  };
}
