/**
 * A Sales voucher for the dummy company, built from the dummy's own masters:
 * a West Bengal debtor, one rated item, CGST and SGST, rounded. The same shape
 * erp-queue-dummy.ts builds inline (review H1). Number ZZTEST<digits>/S<n>, so
 * the sweep removes it; REMOTEID MKCP|SALES|<number>, a spelling the sweep tries.
 */
import { loadMasters, gstRateFor } from "../../../src/services/tallyMasters.js";
import type { VoucherPayload } from "../../../src/types.js";

export async function dummySaleBuilder(tallyUrl: string, company: string, day: string, stamp: string, label: string) {
  const m = await loadMasters(tallyUrl, company, { force: true });
  const led = (re: RegExp) => [...m.ledgers.keys()].find((x) => re.test(x));
  const need = { outCgst: led(/^OUTPUT CGST$/i), outSgst: led(/^OUTPUT SGST$/i), salesWb: led(/^SALES {2}\( GST W\.B\. \)$/), roundOff: led(/^ROUNDED OFF$/i) };
  const debtor = [...m.ledgers.values()].find((l) => /Sundry Debtors/i.test(l.parent) && l.gstin && /west bengal/i.test(l.state) && l.pincode);
  const it = [...m.items.values()].find((i) => i.baseUnit && gstRateFor(m, i.name, day).rate > 0);
  if (!debtor || !it || Object.values(need).some((v) => !v)) throw new Error("the dummy's masters lack a debtor, a rated item or the sales ledgers");
  const godown = [...m.godowns][0];
  return (k: number, amountBase = 800): VoucherPayload => {
    const amount = amountBase + k, rate = gstRateFor(m, it.name, day).rate;
    const half = Math.round(amount * rate / 2) / 100, exact = Math.round((amount + 2 * half) * 100) / 100;
    const grand = Math.round(exact), ro = Math.round((grand - exact) * 100) / 100;
    const number = `ZZTEST${stamp}/S${k}`;
    return {
      voucherType: "Sales", date: day, voucherNumber: number, remoteId: `MKCP|SALES|${number}`,
      narration: `ZZTEST${stamp} rig sale`, isInvoice: true, partyLedgerName: debtor.name,
      ledgerEntries: [
        { ledgerName: debtor.name, amount: grand, isDeemedPositive: true, isPartyLedger: true },
        { ledgerName: need.outCgst!, amount: half, isDeemedPositive: false, isPartyLedger: false },
        { ledgerName: need.outSgst!, amount: half, isDeemedPositive: false, isPartyLedger: false },
        ...(ro ? [{ ledgerName: need.roundOff!, amount: Math.abs(ro), isDeemedPositive: false, isPartyLedger: false, signedAmount: ro }] : []),
      ],
      inventoryEntries: [{ stockItemName: it.name, quantity: 1, unit: it.baseUnit, rate: amount, amount, isDeemedPositive: false,
        salesLedgerName: need.salesWb!, godownName: godown, batchName: "Primary Batch" }],
      label,
    } as unknown as VoucherPayload;
  };
}
