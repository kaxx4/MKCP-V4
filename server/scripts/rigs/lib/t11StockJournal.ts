/**
 * JOB: the vouchers rig C22 sends (a Stock Journal from a warehouse count difference), as pure data.
 * Kept apart from t11Scenarios.ts because it exercises the new builder (src/services/stockJournal.ts).
 *
 * The count found MORE than the books say: stock IN. It found LESS: stock OUT. The loss is taken from the
 * item the gain just put in, so no item is ever driven below nothing on the dummy.
 */
import type { InventoryEntry, VoucherPayload } from "../../../src/types.js";
import { zzItems, zzNarration, zzNumber, zzRemoteId, type Kit, type ZzItem } from "./t11Kit.js";

const stockLine = (it: ZzItem, qty: number, rate: number, kit: Kit, inward: boolean): InventoryEntry => ({
  stockItemName: it.name, quantity: qty, unit: it.baseUnit, rate, amount: Math.round(qty * rate * 100) / 100,
  isDeemedPositive: inward, salesLedgerName: "", godownName: kit.godown, batchName: kit.batch,
});

export function stockJournalVoucher(o: { kit: Kit; number: string; date: string; narration: string; lines: InventoryEntry[]; action?: VoucherPayload["action"] }): VoucherPayload {
  return {
    voucherType: "Stock Journal", date: o.date, voucherNumber: o.number, isInvoice: false, action: o.action,
    remoteId: zzRemoteId("STOCK JOURNAL", o.number), narration: o.narration, partyLedgerName: "",
    ledgerEntries: [], inventoryEntries: o.lines,
  } as VoucherPayload;
}

export function stockJournalScenario(stamp: string, day: string, kit: Kit) {
  const [a, b] = zzItems(stamp, kit);
  return {
    items: [a, b],
    /** Count found 4 more of item A than the books: stock IN. */
    gain: stockJournalVoucher({ kit, number: zzNumber(stamp, "J1"), date: day, narration: zzNarration(stamp, "count difference: found more"), lines: [stockLine(a, 4, 100, kit, true)] }),
    /** Count found 1 fewer of item A: stock OUT. */
    loss: stockJournalVoucher({ kit, number: zzNumber(stamp, "J2"), date: day, narration: zzNarration(stamp, "count difference: found less"), lines: [stockLine(a, 1, 100, kit, false)] }),
    /** Both directions in one voucher: B in, A out (a recount that moves stock between two items). */
    mixed: stockJournalVoucher({ kit, number: zzNumber(stamp, "J3"), date: day, narration: zzNarration(stamp, "count difference: mixed"), lines: [stockLine(b, 2, 50, kit, true), stockLine(a, 1, 100, kit, false)] }),
    /** After gain (+4) and loss (-1) item A holds 3; after the mixed voucher A holds 2 and B holds 2. */
    expected: { afterGain: new Map([[a.name, 4]]), afterLoss: new Map([[a.name, 3]]), afterMixed: new Map([[a.name, 2], [b.name, 2]]) },
  };
}
