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
    for (const line of v.lines) {
      if (line.type !== "inventory" || !line.itemId) continue;
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

/** Compute monthly inwards/outwards for one item */
export function computeMonthlyBuckets(
  item: CanonicalItem,
  vouchers: CanonicalVoucher[],
  nMonths: number = 8,
  asOfDate?: Date
): MonthBucket[] {
  const months = getMonthRange(nMonths + 1, asOfDate); // +1 to compute opening of first shown month

  const monthlyIn: Record<string, number> = {};
  const monthlyOut: Record<string, number> = {};

  for (const v of vouchers) {
    if (v.isCancelled || v.isOptional) continue;
    const ym = v.date.slice(0, 7);
    for (const line of v.lines) {
      if (line.type !== "inventory" || line.itemId !== item.itemId) continue;
      const qty = line.qtyBase ?? 0;
      if (
        v.voucherType === "Sales" ||
        v.voucherType === "Credit Note"
      ) {
        monthlyOut[ym] = (monthlyOut[ym] ?? 0) + qty;
      } else if (
        v.voucherType === "Purchase" ||
        v.voucherType === "Debit Note"
      ) {
        monthlyIn[ym] = (monthlyIn[ym] ?? 0) + qty;
      } else if (v.voucherType === "Stock Journal") {
        if (qty > 0) monthlyIn[ym] = (monthlyIn[ym] ?? 0) + qty;
        else monthlyOut[ym] = (monthlyOut[ym] ?? 0) + Math.abs(qty);
      }
    }
  }

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

/** Get current closing stock for an item */
export function getCurrentStock(item: CanonicalItem, vouchers: CanonicalVoucher[]): number {
  let running = item.openingQtyBase;
  for (const v of vouchers) {
    if (v.isCancelled || v.isOptional) continue;
    for (const line of v.lines) {
      if (line.type !== "inventory" || line.itemId !== item.itemId) continue;
      const qty = line.qtyBase ?? 0;
      if (["Sales", "Credit Note"].includes(v.voucherType)) {
        running -= qty;
      } else if (["Purchase", "Debit Note"].includes(v.voucherType)) {
        running += qty;
      } else if (v.voucherType === "Stock Journal") {
        running += qty; // Stock Journal qty can be +ve or -ve
      }
    }
  }
  return running;
}

/** Average monthly outward for last N months */
export function avgMonthlyOutward(
  item: CanonicalItem,
  vouchers: CanonicalVoucher[],
  nMonths: number = 3
): number {
  const buckets = computeMonthlyBuckets(item, vouchers, nMonths);
  if (!buckets.length) return 0;
  const total = buckets.reduce((s, b) => s + b.outwardsBase, 0);
  return total / buckets.length;
}

/** Suggested reorder quantity */
export function suggestedReorder(
  item: CanonicalItem,
  vouchers: CanonicalVoucher[],
  currentStock: number,
  leadTimeMonths: number = 1.5,
  minReorder: number = 0
): number {
  const avg = avgMonthlyOutward(item, vouchers);
  const needed = avg * leadTimeMonths - currentStock;
  return Math.max(Math.ceil(needed), minReorder);
}

/**
 * Get current stock using voucher index (optimized)
 */
export function getCurrentStockIndexed(item: CanonicalItem, voucherIndex: VoucherIndex): number {
  let running = item.openingQtyBase;
  const itemVouchers = voucherIndex.get(item.itemId) ?? [];

  for (const v of itemVouchers) {
    for (const line of v.lines) {
      if (line.type !== "inventory" || line.itemId !== item.itemId) continue;
      const qty = line.qtyBase ?? 0;
      if (["Sales", "Credit Note"].includes(v.voucherType)) {
        running -= qty;
      } else if (["Purchase", "Debit Note"].includes(v.voucherType)) {
        running += qty;
      } else if (v.voucherType === "Stock Journal") {
        running += qty;
      }
    }
  }
  return running;
}

/**
 * Compute monthly buckets using voucher index (optimized)
 */
export function computeMonthlyBucketsIndexed(
  item: CanonicalItem,
  voucherIndex: VoucherIndex,
  nMonths: number = 8,
  asOfDate?: Date
): MonthBucket[] {
  const months = getMonthRange(nMonths + 1, asOfDate);
  const monthlyIn: Record<string, number> = {};
  const monthlyOut: Record<string, number> = {};

  const itemVouchers = voucherIndex.get(item.itemId) ?? [];

  for (const v of itemVouchers) {
    const ym = v.date.slice(0, 7);
    for (const line of v.lines) {
      if (line.type !== "inventory" || line.itemId !== item.itemId) continue;
      const qty = line.qtyBase ?? 0;
      if (
        v.voucherType === "Sales" ||
        v.voucherType === "Credit Note"
      ) {
        monthlyOut[ym] = (monthlyOut[ym] ?? 0) + qty;
      } else if (
        v.voucherType === "Purchase" ||
        v.voucherType === "Debit Note"
      ) {
        monthlyIn[ym] = (monthlyIn[ym] ?? 0) + qty;
      } else if (v.voucherType === "Stock Journal") {
        if (qty > 0) monthlyIn[ym] = (monthlyIn[ym] ?? 0) + qty;
        else monthlyOut[ym] = (monthlyOut[ym] ?? 0) + Math.abs(qty);
      }
    }
  }

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

export interface ItemTurnoverData {
  itemId: string;
  name: string;
  group: string;
  baseUnit: string;
  // Value-based
  cogsValue: number;           // total sales value in period
  openingValue: number;        // opening inventory value
  closingValue: number;        // closing inventory value
  avgInventoryValue: number;   // (opening + closing) / 2
  turnoverRatio: number;       // COGS / avgInventory (0 if no inventory)
  daysOfInventory: number;     // periodDays / turnoverRatio (Infinity if ratio=0)
  // Quantity-based
  totalOutwardQty: number;     // total units sold in period
  totalInwardQty: number;      // total units purchased in period
  openingQty: number;
  closingQty: number;
  avgMonthlyOutward: number;   // outward qty / months
  // Classification
  classification: "fast" | "moderate" | "slow" | "dead";
}

/**
 * Compute inventory turnover data for ALL items over a given period.
 * @param items - all items
 * @param vouchers - all vouchers
 * @param periodMonths - number of months to analyze (3, 6, 12)
 */
export function computeItemTurnover(
  items: Map<string, CanonicalItem>,
  vouchers: CanonicalVoucher[],
  periodMonths: number = 12
): ItemTurnoverData[] {
  const periodDays = periodMonths * 30; // approximate
  const results: ItemTurnoverData[] = [];

  // Determine period range from data (use latest voucher date as end)
  let latestDate = "";
  for (const v of vouchers) {
    if (v.date > latestDate) latestDate = v.date;
  }
  if (!latestDate) return [];

  const endDate = latestDate;
  const endDateObj = new Date(endDate);
  const startDateObj = new Date(endDateObj);
  startDateObj.setMonth(startDateObj.getMonth() - periodMonths);
  const startDate = startDateObj.toISOString().slice(0, 10);

  for (const [, item] of items) {
    let totalOutQty = 0;
    let totalOutValue = 0;
    let totalInQty = 0;

    // Compute opening stock at startDate by rolling forward from FY opening
    let runningQty = item.openingQtyBase;
    // Pre-period movements (everything before startDate)
    for (const v of vouchers) {
      if (v.isCancelled || v.isOptional || v.date >= startDate) continue;
      for (const line of v.lines) {
        if (line.type !== "inventory" || line.itemId !== item.itemId) continue;
        const qty = line.qtyBase ?? 0;
        if (["Sales", "Credit Note"].includes(v.voucherType)) runningQty -= qty;
        else if (["Purchase", "Debit Note"].includes(v.voucherType)) runningQty += qty;
        else if (v.voucherType === "Stock Journal") runningQty += qty;
      }
    }
    const openingQty = runningQty;

    // In-period movements
    for (const v of vouchers) {
      if (v.isCancelled || v.isOptional) continue;
      if (v.date < startDate || v.date > endDate) continue;
      for (const line of v.lines) {
        if (line.type !== "inventory" || line.itemId !== item.itemId) continue;
        const qty = line.qtyBase ?? 0;
        const lineVal = line.lineAmount ?? qty * (line.ratePerBase ?? item.openingRate);
        if (["Sales", "Credit Note"].includes(v.voucherType)) {
          totalOutQty += qty;
          totalOutValue += lineVal;
          runningQty -= qty;
        } else if (["Purchase", "Debit Note"].includes(v.voucherType)) {
          totalInQty += qty;
          runningQty += qty;
        } else if (v.voucherType === "Stock Journal") {
          if (qty > 0) totalInQty += qty;
          else totalOutQty += Math.abs(qty);
          runningQty += qty;
        }
      }
    }
    const closingQty = runningQty;

    const openingValue = openingQty * item.openingRate;
    const closingValue = closingQty * item.openingRate;
    const avgInventoryValue = (openingValue + closingValue) / 2;
    const turnoverRatio = avgInventoryValue > 0.01 ? totalOutValue / avgInventoryValue : 0;
    const daysOfInventory = turnoverRatio > 0 ? periodDays / turnoverRatio : Infinity;

    // Classification thresholds (annualized turnover):
    // Fast: turns > 6x/year, Moderate: 2-6x, Slow: 0.5-2x, Dead: < 0.5x
    const annualizedTurns = turnoverRatio * (12 / periodMonths);
    let classification: ItemTurnoverData["classification"];
    if (annualizedTurns >= 6) classification = "fast";
    else if (annualizedTurns >= 2) classification = "moderate";
    else if (annualizedTurns >= 0.5) classification = "slow";
    else classification = "dead";

    results.push({
      itemId: item.itemId,
      name: item.name,
      group: item.group,
      baseUnit: item.baseUnit,
      cogsValue: totalOutValue,
      openingValue,
      closingValue,
      avgInventoryValue,
      turnoverRatio: Math.round(turnoverRatio * 100) / 100,
      daysOfInventory: isFinite(daysOfInventory) ? Math.round(daysOfInventory) : Infinity,
      totalOutwardQty: totalOutQty,
      totalInwardQty: totalInQty,
      openingQty,
      closingQty,
      avgMonthlyOutward: periodMonths > 0 ? totalOutQty / periodMonths : 0,
      classification,
    });
  }

  return results;
}
