/**
 * JOB: the money-voucher matrix (D-M.164) as pure data: Receipt, Payment and Contra, each with every bill
 * allocation type (New Ref, Agst Ref one/several/part/over, Advance, On Account, a mix of 9 bills plus On
 * Account), a ledger that is not bill-by-bill, cash and bank (cheque number, UTR, no instrument), a payment
 * to an expense ledger, a payment with TDS taken off, and Alter / Cancel / Delete of one of each.
 *
 * No Tally here. The bills the money settles are made first (sales invoices to a ZZ TEST debtor, freight
 * bills from a ZZ TEST carrier), so every Agst Ref names a real open bill. Fake data only.
 */
import type { BankAllocation, BillAllocation, LedgerEntry, VoucherPayload } from "../../../src/types.js";
import { DUMMY_KIT, buildFreightBill, buildSale, r2, saleTotals, zzItems, zzNarration, zzNumber, zzRemoteId, type Kit, type ZzItem, type ZzParty } from "./t11Kit.js";
import { fakeGstin } from "./t11Kit.js";

export type MoneyType = "Receipt" | "Payment" | "Contra";

export function moneyParties(stamp: string): Record<"debtor" | "carrier" | "expense" | "plainDebtor", ZzParty> {
  const n = Number(stamp) % 8000;
  return {
    debtor: { name: `ZZ TEST DEBTOR ${stamp}`, parent: "Sundry Debtors", state: "West Bengal", gstin: fakeGstin("19", n + 11), pincode: "700001", address: ["ZZ TEST LANE 11", "KOLKATA 700001"], gstRegistrationType: "Regular" },
    carrier: { name: `ZZ TEST CARRIER ${stamp}`, parent: "SUNDRY CREDITORS (FREIGHT)", state: "West Bengal", gstin: "", pincode: "700002", address: ["ZZ TEST DEPOT 12", "KOLKATA 700002"], gstRegistrationType: "Unregistered" },
    expense: { name: `ZZ TEST EXPENSE ${stamp}`, parent: "Indirect Expenses", state: "West Bengal", gstin: "", pincode: "700003", address: ["ZZ TEST OFFICE 13", "KOLKATA 700003"], gstRegistrationType: "Unregistered", billWise: false },
    plainDebtor: { name: `ZZ TEST PLAIN DEBTOR ${stamp}`, parent: "Sundry Debtors", state: "West Bengal", gstin: "", pincode: "700004", address: ["ZZ TEST ROW 14", "KOLKATA 700004"], gstRegistrationType: "Unregistered", billWise: false },
  };
}

/** Bank instruments as the real books carry them: a cheque with a number, a transfer with a UTR, a cheque with none. */
export const chequeWithNumber = (no: string, favouring: string): BankAllocation => ({ transactionType: "Cheque/DD", transferMode: "", instrumentNumber: no, favouring });
export const transferWithUtr = (utr: string, favouring: string): BankAllocation => ({ transactionType: "Others", transferMode: "NEFT", instrumentNumber: utr, favouring });
export const chequeNoNumber = (favouring: string): BankAllocation => ({ transactionType: "Cheque", transferMode: "", instrumentNumber: "", favouring });

const partyLine = (name: string, amount: number, debit: boolean, allocs?: BillAllocation[]): LedgerEntry =>
  ({ ledgerName: name, amount: r2(amount), isDeemedPositive: debit, isPartyLedger: true, ...(allocs ? { billAllocations: allocs } : {}) });
const acctLine = (name: string, amount: number, debit: boolean, bank?: BankAllocation): LedgerEntry =>
  ({ ledgerName: name, amount: r2(amount), isDeemedPositive: debit, isPartyLedger: false, ...(bank ? { bankAllocation: bank } : {}) });

export interface MoneyOpts { type: MoneyType; number: string; date: string; narration: string; lines: LedgerEntry[]; action?: VoucherPayload["action"] }

/** The party ledger of a Receipt/Payment is its first non-bank, non-cash line; a Contra's is its first debit (Tally's convention). */
export function moneyVoucher(o: MoneyOpts): VoucherPayload {
  const party = o.type === "Contra" ? o.lines.find((l) => l.isDeemedPositive)!.ledgerName : o.lines.find((l) => l.isPartyLedger)!.ledgerName;
  return {
    voucherType: o.type, date: o.date, voucherNumber: o.number, isInvoice: false, action: o.action,
    remoteId: zzRemoteId(o.type, o.number), narration: o.narration, partyLedgerName: party, ledgerEntries: o.lines,
  } as VoucherPayload;
}

/** A receipt: the debtor is credited (with allocations), the bank or cash is debited for the whole. */
export const receipt = (o: { number: string; date: string; narration: string; party: string; amount: number; into: string; bank?: BankAllocation; allocs?: BillAllocation[] }): VoucherPayload =>
  moneyVoucher({ type: "Receipt", number: o.number, date: o.date, narration: o.narration, lines: [partyLine(o.party, o.amount, false, o.allocs), acctLine(o.into, o.amount, true, o.bank)] });

/** A payment: the creditor (or expense ledger) is debited (with allocations), the bank or cash is credited. */
export const payment = (o: { number: string; date: string; narration: string; party: string; amount: number; from: string; bank?: BankAllocation; allocs?: BillAllocation[]; extra?: LedgerEntry[]; fromAmount?: number }): VoucherPayload =>
  moneyVoucher({ type: "Payment", number: o.number, date: o.date, narration: o.narration, lines: [partyLine(o.party, o.amount, true, o.allocs), ...(o.extra ?? []), acctLine(o.from, o.fromAmount ?? o.amount, false, o.bank)] });

/** A contra: `to` is debited, `from` is credited, same amount. A bank side carries an instrument. */
export const contra = (o: { number: string; date: string; narration: string; to: string; from: string; amount: number; toBank?: BankAllocation; fromBank?: BankAllocation }): VoucherPayload =>
  moneyVoucher({ type: "Contra", number: o.number, date: o.date, narration: o.narration, lines: [acctLine(o.to, o.amount, true, o.toBank), acctLine(o.from, o.amount, false, o.fromBank)] });

/** What one case should leave open for a bill afterwards: `remaining` is the magnitude still owed (0 = settled and gone). */
export interface BillExpect { party: string; name: string; remaining: number; /** false = record what Tally did but do not judge it (overpayment). */ judge?: boolean }

export interface MoneyCase { id: string; label: string; voucher: VoucherPayload; expect?: BillExpect[]; kind: "receipt" | "payment" | "contra" }

export function moneyScenario(stamp: string, day: string, kit: Kit = DUMMY_KIT, opts: { tdsLedger?: string; secondBank?: string } = {}) {
  const parties = moneyParties(stamp);
  const D = parties.debtor.name, C = parties.carrier.name, E = parties.expense.name, N = parties.plainDebtor.name;
  const item: ZzItem = zzItems(stamp, kit)[0];
  const num = (t: string) => zzNumber(stamp, t);
  const nar = (w: string) => zzNarration(stamp, w);

  /** 14 sales invoices to the debtor make 14 open bills (rates differ so the amounts differ). */
  const sales = Array.from({ length: 14 }, (_, i) => buildSale({
    kit, type: "Sales", number: num(`S${i + 1}`), date: day, narration: nar(`bill S${i + 1} for the money matrix`), party: { name: D },
    lines: [{ item: item.name, unit: "PC", qty: 1 + (i % 3), rate: 100 + i * 37, gstRate: item.gstRate }],
  }));
  const g = sales.map((s) => saleTotals(s).grand);
  const billOf = (i: number): string => sales[i].voucherNumber!;

  /** 8 freight bills from the carrier make 8 open payables. */
  const freightAmounts = [1000, 2000, 3000, 4000, 5000, 600, 700, 1000];
  const freight = freightAmounts.map((a, i) => buildFreightBill({ kit, number: num(`F${i + 1}`), date: day, narration: nar(`freight bill F${i + 1} for the money matrix`), carrier: { name: C }, billNo: `ZZTBILL${stamp}-${i + 1}`, amount: a }));
  const fBill = (i: number): string => `ZZTBILL${stamp}-${i + 1}`;
  const agst = (name: string, amount: number): BillAllocation => ({ name, billType: "Agst Ref", amount: r2(amount) });
  const onAcct = (amount: number): BillAllocation => ({ name: "On Account", billType: "On Account", amount: r2(amount) });
  const cases: MoneyCase[] = [];
  const add = (c: MoneyCase) => cases.push(c);

  // ── Receipts (the debtor pays us) ───────────────────────────────────────
  add({ id: "R1", kind: "receipt", label: "Receipt, one bill settled in full, bank, cheque with a number",
    voucher: receipt({ number: num("R1"), date: day, narration: nar("R1 one bill full"), party: D, amount: g[0], into: kit.bank, bank: chequeWithNumber(`ZZCHQ${stamp}1`, D), allocs: [agst(billOf(0), g[0])] }),
    expect: [{ party: D, name: billOf(0), remaining: 0 }] });
  add({ id: "R2", kind: "receipt", label: "Receipt, several bills in full, bank, transfer with a UTR",
    voucher: receipt({ number: num("R2"), date: day, narration: nar("R2 two bills"), party: D, amount: r2(g[1] + g[2]), into: kit.bank, bank: transferWithUtr(`ZZUTR${stamp}2`, D), allocs: [agst(billOf(1), g[1]), agst(billOf(2), g[2])] }),
    expect: [{ party: D, name: billOf(1), remaining: 0 }, { party: D, name: billOf(2), remaining: 0 }] });
  const part = Math.floor(g[3] / 2);
  add({ id: "R3", kind: "receipt", label: "Receipt, part payment of one bill, cash",
    voucher: receipt({ number: num("R3"), date: day, narration: nar("R3 part payment"), party: D, amount: part, into: kit.cash, allocs: [agst(billOf(3), part)] }),
    expect: [{ party: D, name: billOf(3), remaining: r2(g[3] - part) }] });
  add({ id: "R4", kind: "receipt", label: "Receipt, one bill overpaid by 50, bank, no instrument number",
    voucher: receipt({ number: num("R4"), date: day, narration: nar("R4 overpay"), party: D, amount: g[4] + 50, into: kit.bank, bank: chequeNoNumber(D), allocs: [agst(billOf(4), g[4] + 50)] }),
    expect: [{ party: D, name: billOf(4), remaining: 50, judge: false }] });
  add({ id: "R5", kind: "receipt", label: "Receipt, Advance (a new bill named by us), cash",
    voucher: receipt({ number: num("R5"), date: day, narration: nar("R5 advance"), party: D, amount: 777, into: kit.cash, allocs: [{ name: `ZZADV${stamp}`, billType: "Advance", amount: 777 }] }),
    expect: [{ party: D, name: `ZZADV${stamp}`, remaining: 777 }] });
  add({ id: "R6", kind: "receipt", label: "Receipt, On Account sent as no allocation at all (how the app sends it), cash",
    voucher: receipt({ number: num("R6"), date: day, narration: nar("R6 on account no allocation"), party: D, amount: 321, into: kit.cash }) });
  add({ id: "R7", kind: "receipt", label: "Receipt, On Account sent as an explicit allocation, cash",
    voucher: receipt({ number: num("R7"), date: day, narration: nar("R7 on account explicit"), party: D, amount: 432, into: kit.cash, allocs: [onAcct(432)] }) });
  const nine = [5, 6, 7, 8, 9, 10, 11, 12, 13];
  const nineSum = r2(nine.reduce((s, i) => s + g[i], 0));
  add({ id: "R8", kind: "receipt", label: "Receipt, 9 bills settled in full plus On Account (the C27 case), bank, UTR",
    voucher: receipt({ number: num("R8"), date: day, narration: nar("R8 nine bills and on account"), party: D, amount: r2(nineSum + 250), into: kit.bank, bank: transferWithUtr(`ZZUTR${stamp}8`, D), allocs: [...nine.map((i) => agst(billOf(i), g[i])), onAcct(250)] }),
    expect: nine.map((i) => ({ party: D, name: billOf(i), remaining: 0 })) });
  add({ id: "R9", kind: "receipt", label: "Receipt, bank with NO instrument detail at all",
    voucher: receipt({ number: num("R9"), date: day, narration: nar("R9 bank no instrument"), party: D, amount: 111, into: kit.bank }) });
  add({ id: "R10", kind: "receipt", label: "Receipt from a ledger that is not bill-by-bill: no allocation sent",
    voucher: receipt({ number: num("R10"), date: day, narration: nar("R10 non bill wise"), party: N, amount: 222, into: kit.cash }) });

  // ── Payments (we pay the carrier, an expense, with TDS) ────────────────
  add({ id: "P1", kind: "payment", label: "Payment, one bill in full, bank, cheque with no number (as the real books mostly are)",
    voucher: payment({ number: num("P1"), date: day, narration: nar("P1 one bill full"), party: C, amount: freightAmounts[0], from: kit.bank, bank: chequeNoNumber(C), allocs: [agst(fBill(0), freightAmounts[0])] }),
    expect: [{ party: C, name: fBill(0), remaining: 0 }] });
  add({ id: "P2", kind: "payment", label: "Payment, several bills in full, bank, transfer with a UTR",
    voucher: payment({ number: num("P2"), date: day, narration: nar("P2 two bills"), party: C, amount: freightAmounts[1] + freightAmounts[2], from: kit.bank, bank: transferWithUtr(`ZZUTR${stamp}P2`, C), allocs: [agst(fBill(1), freightAmounts[1]), agst(fBill(2), freightAmounts[2])] }),
    expect: [{ party: C, name: fBill(1), remaining: 0 }, { party: C, name: fBill(2), remaining: 0 }] });
  add({ id: "P3", kind: "payment", label: "Payment, part payment of one bill, cash",
    voucher: payment({ number: num("P3"), date: day, narration: nar("P3 part payment"), party: C, amount: 1500, from: kit.cash, allocs: [agst(fBill(3), 1500)] }),
    expect: [{ party: C, name: fBill(3), remaining: 2500 }] });
  add({ id: "P4", kind: "payment", label: "Payment, one bill overpaid by 100, cash",
    voucher: payment({ number: num("P4"), date: day, narration: nar("P4 overpay"), party: C, amount: 5100, from: kit.cash, allocs: [agst(fBill(4), 5100)] }),
    expect: [{ party: C, name: fBill(4), remaining: 100, judge: false }] });
  add({ id: "P5", kind: "payment", label: "Payment, Advance to the carrier, bank, cheque with a number",
    voucher: payment({ number: num("P5"), date: day, narration: nar("P5 advance"), party: C, amount: 888, from: kit.bank, bank: chequeWithNumber(`ZZCHQ${stamp}5`, C), allocs: [{ name: `ZZPADV${stamp}`, billType: "Advance", amount: 888 }] }),
    expect: [{ party: C, name: `ZZPADV${stamp}`, remaining: 888 }] });
  add({ id: "P6", kind: "payment", label: "Payment, On Account with no allocation, cash",
    voucher: payment({ number: num("P6"), date: day, narration: nar("P6 on account"), party: C, amount: 99, from: kit.cash }) });
  add({ id: "P7", kind: "payment", label: "Payment, two bills in full plus On Account in one voucher, bank, UTR",
    voucher: payment({ number: num("P7"), date: day, narration: nar("P7 bills and on account"), party: C, amount: 600 + 700 + 100, from: kit.bank, bank: transferWithUtr(`ZZUTR${stamp}P7`, C), allocs: [agst(fBill(5), 600), agst(fBill(6), 700), onAcct(100)] }),
    expect: [{ party: C, name: fBill(5), remaining: 0 }, { party: C, name: fBill(6), remaining: 0 }] });
  add({ id: "P8", kind: "payment", label: "Payment to an expense ledger (not bill-by-bill), cash, no allocation",
    voucher: payment({ number: num("P8"), date: day, narration: nar("P8 expense"), party: E, amount: 345, from: kit.cash }) });
  if (opts.tdsLedger) {
    add({ id: "P9", kind: "payment", label: `Payment with TDS taken off (${opts.tdsLedger}): bill 1000, TDS 20, bank 980`,
      voucher: payment({ number: num("P9"), date: day, narration: nar("P9 with tds"), party: C, amount: 1000, from: kit.bank, bank: chequeWithNumber(`ZZCHQ${stamp}9`, C), fromAmount: 980,
        allocs: [agst(fBill(7), 1000)], extra: [acctLine(opts.tdsLedger, 20, false)] }),
      expect: [{ party: C, name: fBill(7), remaining: 0 }] });
  }

  // ── Contras ────────────────────────────────────────────────────────────
  add({ id: "K1", kind: "contra", label: "Contra, cash to bank (deposit)",
    voucher: contra({ number: num("K1"), date: day, narration: nar("K1 cash to bank"), to: kit.bank, from: kit.cash, amount: 1234, toBank: chequeWithNumber(`ZZDEP${stamp}1`, kit.bank) }) });
  add({ id: "K2", kind: "contra", label: "Contra, bank to cash (withdrawal)",
    voucher: contra({ number: num("K2"), date: day, narration: nar("K2 bank to cash"), to: kit.cash, from: kit.bank, amount: 567, fromBank: chequeWithNumber(`ZZWDR${stamp}2`, kit.cash) }) });
  if (opts.secondBank) {
    add({ id: "K3", kind: "contra", label: `Contra, bank to bank (${opts.secondBank})`,
      voucher: contra({ number: num("K3"), date: day, narration: nar("K3 bank to bank"), to: opts.secondBank, from: kit.bank, amount: 890,
        toBank: transferWithUtr(`ZZUTR${stamp}K3`, opts.secondBank), fromBank: transferWithUtr(`ZZUTR${stamp}K3`, kit.bank) }) });
  }

  // ── Alter / Cancel / Delete: one of each, on dedicated vouchers so no bill picture depends on them ──
  const lifeR = receipt({ number: num("LR"), date: day, narration: nar("LR life receipt"), party: D, amount: 150, into: kit.bank, bank: chequeWithNumber(`ZZCHQ${stamp}L`, D) });
  const lifeP = payment({ number: num("LP"), date: day, narration: nar("LP life payment"), party: C, amount: 160, from: kit.bank, bank: chequeWithNumber(`ZZCHQ${stamp}M`, C) });
  const lifeK = contra({ number: num("LK"), date: day, narration: nar("LK life contra"), to: kit.bank, from: kit.cash, amount: 170, toBank: chequeWithNumber(`ZZDEP${stamp}L`, kit.bank) });

  return { parties, item, sales, freight, cases, lifeR, lifeP, lifeK, g, freightAmounts, billOf, fBill, nineSum };
}

/** The same voucher with a new amount and instrument number and an extra word in the narration: what an Alter changes. */
export function alteredCopy(p: VoucherPayload, newAmount: number, newInstrument: string): VoucherPayload {
  return {
    ...p, action: "Alter", narration: `${p.narration} altered`,
    ledgerEntries: p.ledgerEntries.map((e) => ({
      ...e, amount: newAmount,
      ...(e.billAllocations ? { billAllocations: e.billAllocations.map((b) => ({ ...b, amount: newAmount })) } : {}),
      ...(e.bankAllocation ? { bankAllocation: { ...e.bankAllocation, instrumentNumber: newInstrument } } : {}),
    })),
  } as VoucherPayload;
}

/** The same voucher under a different number (so two of one kind can stand side by side): new number, REMOTEID and narration tag. */
export function variant(p: VoucherPayload, tag: string): VoucherPayload {
  const number = `${p.voucherNumber}${tag}`;
  return { ...p, voucherNumber: number, remoteId: zzRemoteId(p.voucherType, number), narration: `${p.narration} ${tag}` } as VoucherPayload;
}
