import type { CanonicalVoucher, CanonicalItem, MonthBucket } from "../types/canonical";

export type VoucherIndex = Map<string, CanonicalVoucher[]>;

/**
 * Build an index of vouchers by itemId for O(V_item) instead of O(V) lookup.
 * Pre-filters out cancelled and optional vouchers.
 */
export function buildVoucherIndex(vouchers: CanonicalVoucher[]): VoucherIndex {
  const idx = new Map<string, CanonicalVoucher[]>();
  for (const v of vouchers) {
    if (v.isCancelled || v.isOptional) continue;
    const seenItems = new Set<string>();
    for (const line of v.lines) {
      if (line.type !== "inventory" || !line.itemId) continue;
      if (seenItems.has(line.itemId)) continue; // prevent duplicate voucher refs per item
      seenItems.add(line.itemId);
      let arr = idx.get(line.itemId);
      if (!arr) { arr = []; idx.set(line.itemId, arr); }
      arr.push(v);
    }
  }
  return idx;
}

/** Returns the last N months as "YYYY-MM" strings, newest last */
export function getMonthRange(nMonths: number, asOfDate?: Date): string[] {
  const end = asOfDate ?? new Date();
  const months: string[] = [];
  for (let i = nMonths - 1; i >= 0; i--) {
    const d = new Date(end.getFullYear(), end.getMonth() - i, 1);
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  return months;
}

export function getMonthLabel(ym: string): string {
  const [y, m] = ym.split("-");
  const date = new Date(Number(y), Number(m) - 1, 1);
  return date.toLocaleString("en-IN", { month: "short", year: "2-digit" });
}

// ─── Shared core helpers ───────────────────────────────────────────────────────

/**
 * Apply a single voucher's inventory lines for one item to running in/out maps.
 * Shared between the indexed and non-indexed bucket implementations.
 */
function _applyVoucherToBuckets(
  v: CanonicalVoucher,
  itemId: string,
  monthlyIn: Record<string, number>,
  monthlyOut: Record<string, number>
): void {
  const ym = v.date.slice(0, 7);
  let totalQty = 0;
  // Accumulate qty for this itemId (only count item once per voucher)
  for (const line of v.lines) {
    if (line.type !== "inventory" || line.itemId !== itemId) continue;
    totalQty += line.qtyBase ?? 0;
  }

  if (totalQty === 0) return;

  if (v.voucherType === "Sales") {
    monthlyOut[ym] = (monthlyOut[ym] ?? 0) + totalQty;
  } else if (v.voucherType === "Credit Note") {
    // Sales return → goods come back in
    monthlyIn[ym] = (monthlyIn[ym] ?? 0) + totalQty;
  } else if (v.voucherType === "Purchase") {
    monthlyIn[ym] = (monthlyIn[ym] ?? 0) + totalQty;
  } else if (v.voucherType === "Debit Note") {
    // Purchase return → goods go back out
    monthlyOut[ym] = (monthlyOut[ym] ?? 0) + totalQty;
  } else if (v.voucherType === "Stock Journal" || v.voucherType === "Journal") {
    if (totalQty > 0) monthlyIn[ym] = (monthlyIn[ym] ?? 0) + totalQty;
    else monthlyOut[ym] = (monthlyOut[ym] ?? 0) + Math.abs(totalQty);
  } else if (v.voucherType === "Delivery Note") {
    monthlyOut[ym] = (monthlyOut[ym] ?? 0) + totalQty;
  }
}

/** Apply a voucher's stock movement for one item to a running total. */
function _applyVoucherToStock(v: CanonicalVoucher, itemId: string, running: number): number {
  let totalQty = 0;
  // Accumulate qty for this itemId (only count item once per voucher)
  for (const line of v.lines) {
    if (line.type !== "inventory" || line.itemId !== itemId) continue;
    totalQty += line.qtyBase ?? 0;
  }

  if (totalQty === 0) return running;

  if (v.voucherType === "Sales") running -= totalQty;
  else if (v.voucherType === "Credit Note") running += totalQty;
  else if (v.voucherType === "Purchase") running += totalQty;
  else if (v.voucherType === "Debit Note") running -= totalQty;
  else if (v.voucherType === "Stock Journal" || v.voucherType === "Journal") running += totalQty;
  else if (v.voucherType === "Delivery Note") running -= totalQty;
  return running;
}

/** Build MonthBucket array from accumulated in/out maps and opening balance. */
function _buildBuckets(
  item: CanonicalItem,
  monthlyIn: Record<string, number>,
  monthlyOut: Record<string, number>,
  months: string[]
): MonthBucket[] {
  const result: MonthBucket[] = [];
  let running = item.openingQtyBase;

  const firstMonth = months[0]!;
  const allMonthsWithMovements = new Set([...Object.keys(monthlyIn), ...Object.keys(monthlyOut)]);
  const preRangeMonths = Array.from(allMonthsWithMovements).filter((m) => m < firstMonth).sort();

  for (const pm of preRangeMonths) {
    running += (monthlyIn[pm] ?? 0) - (monthlyOut[pm] ?? 0);
  }

  for (const ym of months) {
    const inw = monthlyIn[ym] ?? 0;
    const out = monthlyOut[ym] ?? 0;
    const closing = running + inw - out;
    if (ym !== months[0]) {
      result.push({
        yearMonth: ym,
        label: getMonthLabel(ym),
        openingQtyBase: running,
        inwardsBase: inw,
        outwardsBase: out,
        closingQtyBase: closing,
      });
    }
    running = closing;
  }

  return result;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Compute monthly inwards/outwards using voucher index (optimized). */
export function computeMonthlyBucketsIndexed(
  item: CanonicalItem,
  voucherIndex: VoucherIndex,
  nMonths: number = 8,
  asOfDate?: Date
): MonthBucket[] {
  const months = getMonthRange(nMonths + 1, asOfDate);
  const monthlyIn: Record<string, number> = {};
  const monthlyOut: Record<string, number> = {};
  for (const v of voucherIndex.get(item.itemId) ?? []) {
    _applyVoucherToBuckets(v, item.itemId, monthlyIn, monthlyOut);
  }
  return _buildBuckets(item, monthlyIn, monthlyOut, months);
}

/** Get current closing stock using voucher index (optimized). */
export function getCurrentStockIndexed(item: CanonicalItem, voucherIndex: VoucherIndex): number {
  let running = item.openingQtyBase;
  for (const v of voucherIndex.get(item.itemId) ?? []) {
    running = _applyVoucherToStock(v, item.itemId, running);
  }
  return running;
}

