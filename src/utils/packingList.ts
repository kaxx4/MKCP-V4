// src/utils/packingList.ts
//
// Builds a packing list from selected sales invoices, expressed in ALTERNATE
// (package) units — what the warehouse picks by. Quantities are always shown in
// the item's pkgUnit when one is configured; items without a package unit fall
// back to their base unit.
//
// Layout: GROUPED BY INVOICE — one section per selected invoice/party, each with
// its own item lines. (No cross-invoice consolidation.)

import type { CanonicalItem, CanonicalVoucher } from "../types/canonical";
import { toDisplay } from "../engine/unitEngine";

export interface PackingListLine {
  itemId: string;
  itemName: string;
  /** Quantity in base units (summed across duplicate lines within the invoice). */
  baseQty: number;
  /** Quantity converted to the alternate/package unit (or base if no pkgUnit). */
  pkgQty: number;
  /** Unit label shown to the picker — pkgUnit when present, else baseUnit. */
  unitLabel: string;
  /** Pre-formatted "5 BOX" string. */
  formatted: string;
  /** Base unit label, for the secondary column. */
  baseUnit: string;
  /** True when this item has a real package unit (so pkgQty differs from baseQty). */
  hasPkgUnit: boolean;
}

export interface PackingListGroup {
  voucherId: string;
  voucherNumber: string;
  date: string;
  partyName: string;
  lines: PackingListLine[];
  /** Total distinct items in this invoice. */
  itemCount: number;
}

/**
 * Build per-invoice packing-list groups (alt units) from the selected sales vouchers.
 * Duplicate inventory lines for the same item within one invoice are summed.
 * Vouchers with no inventory lines are skipped.
 */
export function buildPackingList(
  selectedVouchers: CanonicalVoucher[],
  items: Map<string, CanonicalItem>
): PackingListGroup[] {
  const groups: PackingListGroup[] = [];

  // Keep selection order stable, but present newest invoices first for readability.
  const sorted = [...selectedVouchers].sort((a, b) => b.date.localeCompare(a.date));

  for (const v of sorted) {
    // Sum qtyBase per item within this invoice.
    const perItem = new Map<string, number>();
    for (const line of v.lines) {
      if (line.type !== "inventory" || !line.itemId) continue;
      perItem.set(line.itemId, (perItem.get(line.itemId) ?? 0) + (line.qtyBase ?? 0));
    }
    if (perItem.size === 0) continue;

    const lines: PackingListLine[] = [];
    for (const [itemId, baseQty] of perItem) {
      const item = items.get(itemId) ?? null;
      // Always express in PKG mode — "as per alt units". toDisplay falls back to the
      // base unit automatically when pkgUnit is null.
      const disp = toDisplay(item, baseQty, "PKG");
      const hasPkgUnit = !!(item?.pkgUnit && item.unitsPerPkg > 0);
      lines.push({
        itemId,
        itemName: item?.name ?? itemId,
        baseQty,
        pkgQty: disp.value,
        unitLabel: disp.label,
        formatted: disp.formatted,
        baseUnit: item?.baseUnit ?? "PCS",
        hasPkgUnit,
      });
    }

    // Sort lines alphabetically by item name for predictable picking order.
    lines.sort((a, b) => a.itemName.localeCompare(b.itemName));

    groups.push({
      voucherId: v.voucherId,
      voucherNumber: v.voucherNumber,
      date: v.date,
      partyName: v.partyName ?? "—",
      lines,
      itemCount: lines.length,
    });
  }

  return groups;
}
