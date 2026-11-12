/**
 * JOB: pure payload builders for the T11 "tally coverage" rigs. No Tally, no Supabase, no clock:
 * everything a rig will send is built here, so `scripts/test-t11-payloads.ts` can prove the SHAPE
 * (guard accepts it, the XML is well formed and balances, REMOTEID and number are a spelling the
 * sweep knows) before a single byte goes to the dummy.
 *
 * Fake data only: names start `ZZ TEST`, GSTINs are the ZZZ series with a real check digit, numbers
 * are `ZZTEST<digits>/<n>`, narrations carry `ZZTEST<digits>` (the sweep needs both).
 */
import { gstinCheckDigit } from "../../../src/services/gstIdentity.js";
import type { InventoryEntry, LedgerEntry, VoucherPayload } from "../../../src/types.js";

/** The dummy's own masters the rigs reuse. These are books, not parties. */
export interface Kit {
  outCgst: string; outSgst: string; outIgst: string;
  inCgst: string; inSgst: string; inIgst: string;
  salesWb: string; salesCentral: string; purchWb: string; purchCentral: string;
  roundOff: string; discount: string; freightRcm: string; cash: string; bank: string; rcmAsset: string;
  godown: string; batch: string;
  /** An existing stock group the new ZZ TEST items sit under. */
  stockGroup: string;
}

/** The names as they stand in the dummy (read 12-Nov-2026 by `rigs/t11-probe-masters.ts`). */
export const DUMMY_KIT: Kit = {
  outCgst: "OUTPUT CGST", outSgst: "OUTPUT SGST", outIgst: "OUTPUT IGST",
  inCgst: "INPUT CGST", inSgst: "INPUT SGST", inIgst: "INPUT IGST",
  salesWb: "SALES  ( GST W.B. )", salesCentral: "SALES  ( GST CENTRAL )",
  purchWb: "PURCHASE ( GST W.B. )", purchCentral: "PURCHASE ( GST CENTRAL )",
  roundOff: "ROUNDED OFF", discount: "TRADE DISCOUNTS / H.C.", freightRcm: "FREIGHT ( UNDER RCM )",
  cash: "Cash", bank: "HDFC BANK", rcmAsset: "GST UNDER RCM",
  godown: "Main Location", batch: "Primary Batch",
  stockGroup: "BICYCLE PARTS ( 87149990 )",
};

export const r2 = (n: number): number => Math.round(n * 100) / 100;

/** A ZZZ-series GSTIN for `stateCode` with a VALID check digit (the guard refuses a bad one). */
export function fakeGstin(stateCode: string, serial: number): string {
  const pan = `ZZZ${String.fromCharCode(65 + (serial % 26))}${String.fromCharCode(65 + (Math.floor(serial / 26) % 26))}${String(1000 + (serial % 9000)).padStart(4, "0")}Z`;
  const first14 = `${stateCode}${pan}1Z`;
  return first14 + gstinCheckDigit(first14);
}

/** The fake parties a rig creates in the dummy. */
export interface ZzParty {
  name: string; parent: string; state: string; gstin: string; pincode: string; address: string[];
  gstRegistrationType: string;
  /** false = the ledger is not bill-by-bill (default true). */
  billWise?: boolean;
}

export function zzParties(stamp: string): Record<"local" | "inter" | "supplier" | "transport", ZzParty> {
  return {
    local: { name: `ZZ TEST PARTY WB ${stamp}`, parent: "Sundry Debtors", state: "West Bengal", gstin: fakeGstin("19", Number(stamp) % 8000 + 1), pincode: "700001", address: ["ZZ TEST LANE 1", "KOLKATA 700001"], gstRegistrationType: "Regular" },
    inter: { name: `ZZ TEST PARTY OD ${stamp}`, parent: "Sundry Debtors", state: "Odisha", gstin: fakeGstin("21", Number(stamp) % 8000 + 2), pincode: "751001", address: ["ZZ TEST ROAD 2", "BHUBANESWAR 751001"], gstRegistrationType: "Regular" },
    supplier: { name: `ZZ TEST SUPPLIER PB ${stamp}`, parent: "Sundry Creditors", state: "Punjab", gstin: fakeGstin("03", Number(stamp) % 8000 + 3), pincode: "141003", address: ["ZZ TEST MARKET 3", "LUDHIANA 141003"], gstRegistrationType: "Regular" },
    transport: { name: `ZZ TEST TRANSPORT ${stamp}`, parent: "SUNDRY CREDITORS (FREIGHT)", state: "West Bengal", gstin: "", pincode: "700002", address: ["ZZ TEST DEPOT 4", "KOLKATA 700002"], gstRegistrationType: "Unregistered" },
  };
}

/** The fake stock items a rig creates (names, group, unit, GST). */
export interface ZzItem { name: string; parent: string; baseUnit: string; gstRate: number; hsn: string }
export function zzItems(stamp: string, kit: Kit = DUMMY_KIT): ZzItem[] {
  return [
    { name: `ZZ TEST ITEM A ${stamp}`, parent: kit.stockGroup, baseUnit: "PC", gstRate: 18, hsn: "87149990" },
    { name: `ZZ TEST ITEM B ${stamp}`, parent: kit.stockGroup, baseUnit: "PC", gstRate: 5, hsn: "87149990" },
  ];
}

export interface Line { item: string; unit: string; qty: number; rate: number; gstRate: number }

/** `ZZTEST<stamp>/<tag>`: the number shape the sweep and the census match. */
export const zzNumber = (stamp: string, tag: string | number): string => `ZZTEST${stamp}/${tag}`;
/** Narration that carries the mark. */
export const zzNarration = (stamp: string, what: string): string => `ZZTEST${stamp} ${what}`;
/** REMOTEID in the spelling the sweep guesses (`MKCP|<TYPE>|<number>`). */
export const zzRemoteId = (type: string, number: string): string => `MKCP|${type.toUpperCase()}|${number}`;

const stockLine = (l: Line, ledger: string, kit: Kit, inward: boolean): InventoryEntry => ({
  stockItemName: l.item, quantity: l.qty, unit: l.unit, rate: l.rate, amount: r2(l.qty * l.rate),
  isDeemedPositive: inward, salesLedgerName: ledger, godownName: kit.godown, batchName: kit.batch,
});

export interface SaleOpts {
  kit: Kit;
  /** "Sales" (an invoice) or "Sales Order Note" (a note: ISINVOICE No, reserves stock). */
  type: "Sales" | "Sales Order Note";
  number: string; date: string; narration: string;
  party: { name: string };
  /** The destination is another state: IGST and the Central sales ledger. */
  inter?: boolean;
  lines: Line[];
  /** Money off the goods, positive number. */
  discount?: number;
  /** Money added to the bill for freight, positive number. */
  freight?: number;
  /** A walk-in on the shared Cash ledger: name and address are typed on the voucher. */
  walkIn?: { name: string; address: string[] };
  action?: VoucherPayload["action"];
  /** Overrides the REMOTEID (a converted note keeps the note's). */
  remoteId?: string;
}

/**
 * A sale or a sales note, tax worked per line on the value after the adjustment (the way the web app
 * does it): discount and freight share out over the lines by value, CGST = SGST halves, rounded to
 * the rupee with a ROUNDED OFF line. Discount and freight sit on ONE `TRADE DISCOUNTS / H.C.` line
 * whose sign is the net (a negative credit when the discount is larger), appropriated to GST.
 */
export function buildSale(o: SaleOpts): VoucherPayload {
  const { kit } = o;
  const gross = r2(o.lines.reduce((s, l) => s + l.qty * l.rate, 0));
  const net = r2((o.freight ?? 0) - (o.discount ?? 0));
  let half = 0, full = 0;
  for (const l of o.lines) {
    const amt = l.qty * l.rate;
    const post = amt + net * (amt / gross);
    half += post * l.gstRate / 200; full += post * l.gstRate / 100;
  }
  const cgst = o.inter ? 0 : r2(half), igst = o.inter ? r2(full) : 0;
  const exact = r2(gross + net + (o.inter ? igst : cgst * 2));
  const grand = Math.round(exact), ro = r2(grand - exact);
  const isInvoice = o.type === "Sales";
  const L: LedgerEntry[] = [{
    ledgerName: o.party.name, amount: grand, isDeemedPositive: true, isPartyLedger: true,
    ...(isInvoice && !o.walkIn ? { billAllocations: [{ name: o.number, billType: "New Ref" as const, amount: grand }] } : {}),
  }];
  if (net !== 0) L.push({ ledgerName: kit.discount, amount: Math.abs(net), isDeemedPositive: false, isPartyLedger: false, signedAmount: net, appropriateToGst: "Goods" });
  if (o.inter) L.push({ ledgerName: kit.outIgst, amount: igst, isDeemedPositive: false, isPartyLedger: false });
  else L.push({ ledgerName: kit.outCgst, amount: cgst, isDeemedPositive: false, isPartyLedger: false }, { ledgerName: kit.outSgst, amount: cgst, isDeemedPositive: false, isPartyLedger: false });
  if (ro) L.push({ ledgerName: kit.roundOff, amount: Math.abs(ro), isDeemedPositive: false, isPartyLedger: false, signedAmount: ro });
  return {
    voucherType: o.type, date: o.date, voucherNumber: o.number, isInvoice, action: o.action,
    remoteId: o.remoteId ?? zzRemoteId(o.type === "Sales" ? "SALES" : "SALES ORDER NOTE", o.number),
    narration: o.narration, partyLedgerName: o.party.name,
    ...(o.walkIn ? { buyerName: o.walkIn.name, buyerAddress: o.walkIn.address, placeOfSupply: "West Bengal" } : {}),
    ledgerEntries: L,
    inventoryEntries: o.lines.map((l) => stockLine(l, o.inter ? kit.salesCentral : kit.salesWb, kit, false)),
  } as VoucherPayload;
}

/** What a sale's party line should read back as (grand total) and its parts, for the split-sales sum. */
export function saleTotals(p: VoucherPayload): { taxable: number; tax: number; adjustment: number; roundOff: number; grand: number } {
  const party = p.ledgerEntries.find((e) => e.isPartyLedger)!;
  const stock = r2((p.inventoryEntries ?? []).reduce((s, i) => s + i.amount, 0));
  const adj = r2(p.ledgerEntries.filter((e) => e.appropriateToGst).reduce((s, e) => s + (e.signedAmount ?? 0), 0));
  const tax = r2(p.ledgerEntries.filter((e) => /^OUTPUT (CGST|SGST|IGST)$/i.test(e.ledgerName)).reduce((s, e) => s + e.amount, 0));
  const ro = r2(p.ledgerEntries.filter((e) => /ROUNDED OFF/i.test(e.ledgerName)).reduce((s, e) => s + (e.signedAmount ?? 0), 0));
  return { taxable: r2(stock + adj), tax, adjustment: adj, roundOff: ro, grand: party.amount };
}

export interface PurchaseOpts {
  kit: Kit;
  number: string; date: string; narration: string;
  supplier: { name: string };
  /** The supplier's own invoice number and date (REFERENCE, REFERENCEDATE) and the bill's name. */
  supplierInvoice: string;
  inter: boolean;
  lines: Line[];
}

/** An inward purchase: stock Dr, input tax Dr, supplier Cr (New Ref named by the supplier's invoice), debit round-off. */
export function buildPurchase(o: PurchaseOpts): VoucherPayload {
  const { kit } = o;
  const goods = r2(o.lines.reduce((s, l) => s + l.qty * l.rate, 0));
  let half = 0, full = 0;
  for (const l of o.lines) { half += l.qty * l.rate * l.gstRate / 200; full += l.qty * l.rate * l.gstRate / 100; }
  const cgst = o.inter ? 0 : r2(half), igst = o.inter ? r2(full) : 0;
  const exact = r2(goods + (o.inter ? igst : cgst * 2));
  const grand = Math.round(exact), ro = r2(grand - exact);
  const L: LedgerEntry[] = [{
    ledgerName: o.supplier.name, amount: grand, isDeemedPositive: false, isPartyLedger: true,
    billAllocations: [{ name: o.supplierInvoice, billType: "New Ref", amount: grand }],
  }];
  if (o.inter) L.push({ ledgerName: kit.inIgst, amount: igst, isDeemedPositive: true, isPartyLedger: false });
  else L.push({ ledgerName: kit.inCgst, amount: cgst, isDeemedPositive: true, isPartyLedger: false }, { ledgerName: kit.inSgst, amount: cgst, isDeemedPositive: true, isPartyLedger: false });
  if (ro) L.push({ ledgerName: kit.roundOff, amount: Math.abs(ro), isDeemedPositive: true, isPartyLedger: false, signedAmount: -ro });
  return {
    voucherType: "Purchase", date: o.date, voucherNumber: o.number, isInvoice: true,
    remoteId: zzRemoteId("PURCHASE", o.number), reference: o.supplierInvoice, referenceDate: o.date,
    narration: o.narration, partyLedgerName: o.supplier.name,
    ledgerEntries: L,
    inventoryEntries: o.lines.map((l) => stockLine(l, o.inter ? kit.purchCentral : kit.purchWb, kit, true)),
  } as VoucherPayload;
}

/**
 * A freight bill from a transporter, booked as the house books it (Brain contract "Freight Rate Card"):
 * a Purchase headed by the carrier, no stock, no GST lines, `Cr carrier` with a New Ref named by the
 * carrier's bill number and `Dr FREIGHT ( UNDER RCM )` for the net. The bill number is also the supplier
 * invoice number, which is how a duplicate is blocked.
 */
export function buildFreightBill(o: { kit: Kit; number: string; date: string; narration: string; carrier: { name: string }; billNo: string; amount: number }): VoucherPayload {
  return {
    voucherType: "Purchase", date: o.date, voucherNumber: o.number, isInvoice: false,
    remoteId: zzRemoteId("PURCHASE", o.number), reference: o.billNo, referenceDate: o.date,
    narration: o.narration, partyLedgerName: o.carrier.name,
    ledgerEntries: [
      { ledgerName: o.carrier.name, amount: o.amount, isDeemedPositive: false, isPartyLedger: true,
        billAllocations: [{ name: o.billNo, billType: "New Ref", amount: o.amount }] },
      { ledgerName: o.kit.freightRcm, amount: o.amount, isDeemedPositive: true, isPartyLedger: false },
    ],
  } as VoucherPayload;
}

/** Pay a bill: Dr carrier against the bill (Agst Ref), Cr cash. */
export function buildBillPayment(o: { kit: Kit; number: string; date: string; narration: string; party: { name: string }; billName: string; amount: number; from?: string }): VoucherPayload {
  return {
    voucherType: "Payment", date: o.date, voucherNumber: o.number, isInvoice: false,
    remoteId: zzRemoteId("PAYMENT", o.number), narration: o.narration, partyLedgerName: o.party.name,
    ledgerEntries: [
      { ledgerName: o.party.name, amount: o.amount, isDeemedPositive: true, isPartyLedger: true,
        billAllocations: [{ name: o.billName, billType: "Agst Ref", amount: o.amount }] },
      { ledgerName: o.from ?? o.kit.cash, amount: o.amount, isDeemedPositive: false, isPartyLedger: false },
    ],
  } as VoucherPayload;
}

/**
 * The reverse-charge tax on a freight bill, booked the way the house books it. Read off 18 operator-typed
 * Journals narrated "BEING GST UNDER RCM" on the dummy (12-Nov-2026): TWO journals per bill, each balanced.
 *   increase (TAXADJUSTMENT "Increase in Tax Liability"): Dr GST UNDER RCM for the whole tax, Cr OUTPUT CGST, Cr OUTPUT SGST
 *   decrease (TAXADJUSTMENT "Decrease in Tax Liability"): Dr INPUT CGST, Dr INPUT SGST, Cr GST UNDER RCM for the whole tax
 * so the holding ledger nets to nil and the tax shows as both output and input. `rate` is the freight GST rate
 * (5 for goods transport), split half and half. The agent's pusher has no way to send the TAXADJUSTMENT flag, so
 * the rig pushes the lines and the rig's report says plainly that the flag is not sent.
 */
export function buildRcmJournals(o: { kit: Kit; numberIncrease: string; numberDecrease: string; date: string; narration: string; taxable: number; rate: number }): { increase: VoucherPayload; decrease: VoucherPayload; half: number; both: number } {
  const half = r2(o.taxable * o.rate / 200);
  const both = r2(half * 2);
  const L = (name: string, amount: number, dr: boolean): LedgerEntry => ({ ledgerName: name, amount, isDeemedPositive: dr, isPartyLedger: false });
  const journal = (number: string, lines: LedgerEntry[], tag: string): VoucherPayload => ({
    voucherType: "Journal", date: o.date, voucherNumber: number, isInvoice: false,
    remoteId: zzRemoteId("JOURNAL", number), narration: `${o.narration} (${tag})`, partyLedgerName: lines.find((l) => l.isDeemedPositive)!.ledgerName,
    ledgerEntries: lines,
  } as VoucherPayload);
  return {
    increase: journal(o.numberIncrease, [L(o.kit.rcmAsset, both, true), L(o.kit.outCgst, half, false), L(o.kit.outSgst, half, false)], "increase"),
    decrease: journal(o.numberDecrease, [L(o.kit.inCgst, half, true), L(o.kit.inSgst, half, true), L(o.kit.rcmAsset, both, false)], "decrease"),
    half, both,
  };
}
