import type { CanonicalVoucher, CanonicalItem } from "../../types/canonical";
import type { VoucherIndex } from "../inventory";

export type MovementDirection = "inward" | "outward";

export interface MovementRecord {
  voucherId: string;
  voucherNumber: string;
  voucherType: string;
  date: string;
  partyName: string;
  itemName: string;
  qty: number;
  rate: number;
  amount: number;
  direction: MovementDirection;
}

/** Voucher types that represent pending/planned outward movements (not stock-affecting) */
export const ORDER_DOC_TYPES = new Set(["Sales Order", "Quotation", "Delivery Note"]);

/** Actual outward voucher types (affect stock) */
export const ACTUAL_OUTWARD_TYPES = new Set(["Sales", "Debit Note", "Delivery Note"]);

/**
 * Get all inward or outward movements for a specific item,
 * optionally filtered to a specific month (YYYY-MM).
 */
export function getItemMovements(
  item: CanonicalItem,
  voucherIndex: VoucherIndex,
  direction: MovementDirection,
  month?: string,
): MovementRecord[] {
  const records: MovementRecord[] = [];
  const itemVouchers = voucherIndex.get(item.itemId) ?? [];

  for (const v of itemVouchers) {
    if (month && !v.date.startsWith(month)) continue;

    for (const line of v.lines) {
      if (line.type !== "inventory" || line.itemId !== item.itemId) continue;
      const qty = line.qtyBase ?? 0;

      let dir: MovementDirection | null = null;

      if (v.voucherType === "Purchase" || v.voucherType === "Credit Note") {
        dir = "inward";
      } else if (v.voucherType === "Sales" || v.voucherType === "Debit Note" || v.voucherType === "Delivery Note") {
        dir = "outward";
      } else if (v.voucherType === "Stock Journal") {
        dir = qty > 0 ? "inward" : "outward";
      }

      if (dir !== direction) continue;

      records.push({
        voucherId: v.voucherId,
        voucherNumber: v.voucherNumber,
        voucherType: v.voucherType,
        date: v.date,
        partyName: v.partyName ?? "—",
        itemName: item.name,
        qty: Math.abs(qty),
        rate: line.ratePerBase ?? 0,
        amount: line.lineAmount ?? 0,
        direction: dir,
      });
    }
  }

  // Sort by date descending (newest first)
  records.sort((a, b) => b.date.localeCompare(a.date));
  return records;
}

/**
 * Get Sales Order and Quotation documents for a specific item from the raw
 * vouchers array (which includes optional/order-type vouchers the voucherIndex
 * excludes). Optionally filtered to a specific month (YYYY-MM).
 */
export function getItemOrderDocs(
  item: CanonicalItem,
  allVouchers: CanonicalVoucher[],
  month?: string,
): MovementRecord[] {
  const records: MovementRecord[] = [];

  for (const v of allVouchers) {
    if (v.isCancelled) continue;
    if (v.voucherType !== "Sales Order" && v.voucherType !== "Quotation") continue;
    if (month && !v.date.startsWith(month)) continue;

    for (const line of v.lines) {
      if (line.type !== "inventory" || line.itemId !== item.itemId) continue;
      const qty = line.qtyBase ?? 0;
      if (qty === 0) continue;

      records.push({
        voucherId: v.voucherId,
        voucherNumber: v.voucherNumber,
        voucherType: v.voucherType,
        date: v.date,
        partyName: v.partyName ?? "—",
        itemName: item.name,
        qty: Math.abs(qty),
        rate: line.ratePerBase ?? 0,
        amount: line.lineAmount ?? 0,
        direction: "outward",
      });
    }
  }

  records.sort((a, b) => b.date.localeCompare(a.date));
  return records;
}

/**
 * Get summary of movements for an item across all months.
 */
export function getItemMovementSummary(
  item: CanonicalItem,
  voucherIndex: VoucherIndex,
): { totalInward: number; totalOutward: number; inwardCount: number; outwardCount: number } {
  const inwards = getItemMovements(item, voucherIndex, "inward");
  const outwards = getItemMovements(item, voucherIndex, "outward");

  return {
    totalInward: inwards.reduce((s, r) => s + r.qty, 0),
    totalOutward: outwards.reduce((s, r) => s + r.qty, 0),
    inwardCount: inwards.length,
    outwardCount: outwards.length,
  };
}
