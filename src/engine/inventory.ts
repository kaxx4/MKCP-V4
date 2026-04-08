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
  for (const line of v.lines) {
    if (line.type !== "inventory" || line.itemId !== itemId) continue;
    const qty = line.qtyBase ?? 0;
    if (v.voucherType === "Sales") {
      monthlyOut[ym] = (monthlyOut[ym] ?? 0) + qty;
    } else if (v.voucherType === "Credit Note") {
      // Sales return → goods come back in
      monthlyIn[ym] = (monthlyIn[ym] ?? 0) + qty;
    } else if (v.voucherType === "Purchase") {
      monthlyIn[ym] = (monthlyIn[ym] ?? 0) + qty;
    } else if (v.voucherType === "Debit Note") {
      // Purchase return → goods go back out
      monthlyOut[ym] = (monthlyOut[ym] ?? 0) + qty;
    } else if (v.voucherType === "Stock Journal" || v.voucherType === "Journal") {
      if (qty > 0) monthlyIn[ym] = (monthlyIn[ym] ?? 0) + qty;
      else monthlyOut[ym] = (monthlyOut[ym] ?? 0) + Math.abs(qty);
    } else if (v.voucherType === "Delivery Note") {
      monthlyOut[ym] = (monthlyOut[ym] ?? 0) + qty;
    }
  }
}

/** Apply a voucher's stock movement for one item to a running total. */
function _applyVoucherToStock(v: CanonicalVoucher, itemId: string, running: number): number {
  for (const line of v.lines) {
    if (line.type !== "inventory" || line.itemId !== itemId) continue;
    const qty = line.qtyBase ?? 0;
    if (v.voucherType === "Sales") running -= qty;
    else if (v.voucherType === "Credit Note") running += qty;
    else if (v.voucherType === "Purchase") running += qty;
    else if (v.voucherType === "Debit Note") running -= qty;
    else if (v.voucherType === "Stock Journal" || v.voucherType === "Journal") running += qty;
    else if (v.voucherType === "Delivery Note") running -= qty;
  }
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

/** Compute monthly inwards/outwards for one item (full voucher scan). */
export function computeMonthlyBuckets(
  item: CanonicalItem,
  vouchers: CanonicalVoucher[],
  nMonths: number = 8,
  asOfDate?: Date
): MonthBucket[] {
  const months = getMonthRange(nMonths + 1, asOfDate);
  const monthlyIn: Record<string, number> = {};
  const monthlyOut: Record<string, number> = {};
  for (const v of vouchers) {
    if (v.isCancelled || v.isOptional) continue;
    _applyVoucherToBuckets(v, item.itemId, monthlyIn, monthlyOut);
  }
  return _buildBuckets(item, monthlyIn, monthlyOut, months);
}

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

/** Get current closing stock for an item (full voucher scan). */
export function getCurrentStock(item: CanonicalItem, vouchers: CanonicalVoucher[]): number {
  let running = item.openingQtyBase;
  for (const v of vouchers) {
    if (v.isCancelled || v.isOptional) continue;
    running = _applyVoucherToStock(v, item.itemId, running);
  }
  return running;
}

/** Get current closing stock using voucher index (optimized). */
export function getCurrentStockIndexed(item: CanonicalItem, voucherIndex: VoucherIndex): number {
  let running = item.openingQtyBase;
  for (const v of voucherIndex.get(item.itemId) ?? []) {
    running = _applyVoucherToStock(v, item.itemId, running);
  }
  return running;
}

/** Average monthly outward for last N months (full scan). */
export function avgMonthlyOutward(
  item: CanonicalItem,
  vouchers: CanonicalVoucher[],
  nMonths: number = 3
): number {
  const buckets = computeMonthlyBuckets(item, vouchers, nMonths);
  if (!buckets.length) return 0;
  return buckets.reduce((s, b) => s + b.outwardsBase, 0) / buckets.length;
}

/** Average monthly outward using voucher index (optimized). */
export function avgMonthlyOutwardIndexed(
  item: CanonicalItem,
  voucherIndex: VoucherIndex,
  nMonths: number = 3
): number {
  const buckets = computeMonthlyBucketsIndexed(item, voucherIndex, nMonths);
  if (!buckets.length) return 0;
  return buckets.reduce((s, b) => s + b.outwardsBase, 0) / buckets.length;
}

/** Suggested reorder quantity (full scan). */
export function suggestedReorder(
  item: CanonicalItem,
  vouchers: CanonicalVoucher[],
  currentStock: number,
  leadTimeMonths: number = 1.5,
  minReorder: number = 0
): number {
  const avg = avgMonthlyOutward(item, vouchers);
  return Math.max(Math.ceil(avg * leadTimeMonths - currentStock), minReorder);
}

/** Suggested reorder using voucher index (optimized). */
export function suggestedReorderIndexed(
  item: CanonicalItem,
  voucherIndex: VoucherIndex,
  currentStock: number,
  leadTimeMonths: number = 1.5,
  minReorder: number = 0
): number {
  const avg = avgMonthlyOutwardIndexed(item, voucherIndex);
  return Math.max(Math.ceil(avg * leadTimeMonths - currentStock), minReorder);
}

export interface ItemTurnoverData {
  itemId: string;
  name: string;
  group: string;
  baseUnit: string;
  cogsValue: number;
  openingValue: number;
  closingValue: number;
  avgInventoryValue: number;
  turnoverRatio: number;
  daysOfInventory: number;
  totalOutwardQty: number;
  totalInwardQty: number;
  openingQty: number;
  closingQty: number;
  avgMonthlyOutward: number;
  classification: "fast" | "moderate" | "slow" | "dead";
}

/**
 * Compute inventory turnover data for ALL items over a given period.
 * Single pass over all vouchers, bucketing by itemId + date phase.
 */
export function computeItemTurnover(
  items: Map<string, CanonicalItem>,
  vouchers: CanonicalVoucher[],
  periodMonths: number = 12
): ItemTurnoverData[] {
  const periodDays = periodMonths * 30;

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

  interface ItemAcc {
    preNetQty: number;
    inPeriodOutQty: number;
    inPeriodOutValue: number;
    inPeriodInQty: number;
    inPeriodNetQty: number;
  }
  const acc = new Map<string, ItemAcc>();

  for (const v of vouchers) {
    if (v.isCancelled || v.isOptional) continue;
    const isPrePeriod = v.date < startDate;
    const isInPeriod = v.date >= startDate && v.date <= endDate;
    if (!isPrePeriod && !isInPeriod) continue;

    for (const line of v.lines) {
      if (line.type !== "inventory" || !line.itemId) continue;
      let a = acc.get(line.itemId);
      if (!a) {
        a = { preNetQty: 0, inPeriodOutQty: 0, inPeriodOutValue: 0, inPeriodInQty: 0, inPeriodNetQty: 0 };
        acc.set(line.itemId, a);
      }

      const qty = line.qtyBase ?? 0;
      const item = items.get(line.itemId);
      const lineVal = line.lineAmount ?? qty * (line.ratePerBase ?? (item?.openingRate ?? 0));

      if (v.voucherType === "Sales") {
        if (isPrePeriod) a.preNetQty -= qty;
        else { a.inPeriodOutQty += qty; a.inPeriodOutValue += lineVal; a.inPeriodNetQty -= qty; }
      } else if (v.voucherType === "Credit Note") {
        if (isPrePeriod) a.preNetQty += qty;
        else { a.inPeriodInQty += qty; a.inPeriodNetQty += qty; }
      } else if (v.voucherType === "Purchase") {
        if (isPrePeriod) a.preNetQty += qty;
        else { a.inPeriodInQty += qty; a.inPeriodNetQty += qty; }
      } else if (v.voucherType === "Debit Note") {
        if (isPrePeriod) a.preNetQty -= qty;
        else { a.inPeriodOutQty += qty; a.inPeriodOutValue += lineVal; a.inPeriodNetQty -= qty; }
      } else if (v.voucherType === "Stock Journal" || v.voucherType === "Journal") {
        if (isPrePeriod) a.preNetQty += qty;
        else {
          if (qty > 0) a.inPeriodInQty += qty;
          else a.inPeriodOutQty += Math.abs(qty);
          a.inPeriodNetQty += qty;
        }
      }
    }
  }

  const results: ItemTurnoverData[] = [];
  for (const [, item] of items) {
    const a = acc.get(item.itemId);
    const openingQty = item.openingQtyBase + (a?.preNetQty ?? 0);
    const closingQty = openingQty + (a?.inPeriodNetQty ?? 0);
    const totalOutQty = a?.inPeriodOutQty ?? 0;
    const totalOutValue = a?.inPeriodOutValue ?? 0;
    const totalInQty = a?.inPeriodInQty ?? 0;

    const openingValue = openingQty * item.openingRate;
    const closingValue = closingQty * item.openingRate;
    const avgInventoryValue = (openingValue + closingValue) / 2;
    const turnoverRatio = avgInventoryValue > 0.01 ? totalOutValue / avgInventoryValue : 0;
    const daysOfInventory = turnoverRatio > 0 ? periodDays / turnoverRatio : Infinity;

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

export interface PeriodComparisonItem {
  itemId: string;
  name: string;
  group: string;
  baseUnit: string;
  openingA: number;
  inwardsA: number;
  outwardsA: number;
  closingA: number;
  openingB: number;
  inwardsB: number;
  outwardsB: number;
  closingB: number;
  closingDelta: number;
  outwardsDelta: number;
  outwardsDeltaPct: number;
}

/**
 * Compare two months side-by-side for every item.
 */
export function computePeriodComparison(
  items: Map<string, CanonicalItem>,
  voucherIndex: VoucherIndex,
  monthA: string,
  monthB: string
): PeriodComparisonItem[] {
  const results: PeriodComparisonItem[] = [];
  const later = monthA > monthB ? monthA : monthB;
  const earlier = monthA <= monthB ? monthA : monthB;

  const [laterY, laterM] = later.split("-").map(Number);
  const [earlierY, earlierM] = earlier.split("-").map(Number);
  const spanMonths = (laterY - earlierY) * 12 + (laterM - earlierM);
  const nMonths = spanMonths + 2;
  const asOfDate = new Date(laterY, laterM - 1 + 1, 0);

  for (const [, item] of items) {
    const buckets = computeMonthlyBucketsIndexed(item, voucherIndex, nMonths, asOfDate);
    const bucketA = buckets.find((b) => b.yearMonth === monthA);
    const bucketB = buckets.find((b) => b.yearMonth === monthB);

    const openingA = bucketA?.openingQtyBase ?? 0;
    const inwardsA = bucketA?.inwardsBase ?? 0;
    const outwardsA = bucketA?.outwardsBase ?? 0;
    const closingA = bucketA?.closingQtyBase ?? 0;
    const openingB = bucketB?.openingQtyBase ?? 0;
    const inwardsB = bucketB?.inwardsBase ?? 0;
    const outwardsB = bucketB?.outwardsBase ?? 0;
    const closingB = bucketB?.closingQtyBase ?? 0;

    const closingDelta = closingB - closingA;
    const outwardsDelta = outwardsB - outwardsA;
    const outwardsDeltaPct = outwardsA > 0
      ? ((outwardsB - outwardsA) / outwardsA) * 100
      : outwardsB > 0 ? 100 : 0;

    results.push({
      itemId: item.itemId, name: item.name, group: item.group, baseUnit: item.baseUnit,
      openingA, inwardsA, outwardsA, closingA,
      openingB, inwardsB, outwardsB, closingB,
      closingDelta, outwardsDelta, outwardsDeltaPct,
    });
  }

  return results;
}

export interface ABCXYZItem {
  itemId: string;
  name: string;
  group: string;
  baseUnit: string;
  totalRevenue: number;
  revenueShare: number;
  cumulativeShare: number;
  abcClass: "A" | "B" | "C";
  avgMonthlyDemand: number;
  coefficientOfVariation: number;
  xyzClass: "X" | "Y" | "Z";
  combined: string;
}

/**
 * Compute ABC-XYZ classification for all items over a given period.
 * ABC = revenue-based Pareto (A ≤80%, B 80-95%, C rest).
 * XYZ = demand variability via coefficient of variation.
 * Single pass over vouchers for efficiency.
 */
export function computeABCXYZ(
  items: Map<string, CanonicalItem>,
  vouchers: CanonicalVoucher[],
  periodMonths: number = 12
): ABCXYZItem[] {
  let latestDate = "";
  for (const v of vouchers) {
    if (v.date > latestDate) latestDate = v.date;
  }
  if (!latestDate) return [];

  const endDateObj = new Date(latestDate);
  const startDateObj = new Date(endDateObj);
  startDateObj.setMonth(startDateObj.getMonth() - periodMonths);
  const startDate = startDateObj.toISOString().slice(0, 10);
  const endDate = latestDate;

  const allMonthKeys: string[] = [];
  const cursor = new Date(startDateObj.getFullYear(), startDateObj.getMonth(), 1);
  const endMonth = new Date(endDateObj.getFullYear(), endDateObj.getMonth(), 1);
  while (cursor <= endMonth) {
    allMonthKeys.push(`${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}`);
    cursor.setMonth(cursor.getMonth() + 1);
  }

  const revenueMap = new Map<string, number>();
  const monthlyOutMap = new Map<string, Map<string, number>>();

  for (const v of vouchers) {
    if (v.isCancelled || v.isOptional || v.voucherType !== "Sales") continue;
    if (v.date < startDate || v.date > endDate) continue;
    const ym = v.date.slice(0, 7);
    for (const line of v.lines) {
      if (line.type !== "inventory" || !line.itemId) continue;
      revenueMap.set(line.itemId, (revenueMap.get(line.itemId) ?? 0) + (line.lineAmount ?? 0));
      let monthMap = monthlyOutMap.get(line.itemId);
      if (!monthMap) { monthMap = new Map(); monthlyOutMap.set(line.itemId, monthMap); }
      monthMap.set(ym, (monthMap.get(ym) ?? 0) + (line.qtyBase ?? 0));
    }
  }

  const grandTotal = Array.from(revenueMap.values()).reduce((s, v) => s + v, 0);
  const itemEntries = Array.from(items.values()).map(item => ({
    itemId: item.itemId, name: item.name, group: item.group, baseUnit: item.baseUnit,
    totalRevenue: revenueMap.get(item.itemId) ?? 0,
  })).sort((a, b) => b.totalRevenue - a.totalRevenue);

  const results: ABCXYZItem[] = [];
  let cumulativeShare = 0;

  for (const entry of itemEntries) {
    const revenueShare = grandTotal > 0 ? (entry.totalRevenue / grandTotal) * 100 : 0;
    cumulativeShare += revenueShare;

    let abcClass: "A" | "B" | "C";
    if (grandTotal === 0) abcClass = "C";
    else if (cumulativeShare <= 80) abcClass = "A";
    else if (cumulativeShare <= 95) abcClass = "B";
    else abcClass = "C";

    const monthMap = monthlyOutMap.get(entry.itemId);
    const monthlyDemands = allMonthKeys.map((ym) => monthMap?.get(ym) ?? 0);
    const totalOutQty = monthlyDemands.reduce((s, q) => s + q, 0);
    const avgMonthlyDemand = periodMonths > 0 ? totalOutQty / periodMonths : 0;

    let coefficientOfVariation: number;
    if (avgMonthlyDemand === 0) {
      coefficientOfVariation = Infinity;
    } else {
      const variance = monthlyDemands.reduce((s, q) => s + (q - avgMonthlyDemand) ** 2, 0) / monthlyDemands.length;
      coefficientOfVariation = Math.sqrt(variance) / avgMonthlyDemand;
    }

    const xyzClass: "X" | "Y" | "Z" = coefficientOfVariation < 0.5 ? "X" : coefficientOfVariation <= 1.0 ? "Y" : "Z";

    results.push({
      itemId: entry.itemId, name: entry.name, group: entry.group, baseUnit: entry.baseUnit,
      totalRevenue: entry.totalRevenue,
      revenueShare: Math.round(revenueShare * 100) / 100,
      cumulativeShare: Math.round(cumulativeShare * 100) / 100,
      abcClass, avgMonthlyDemand: Math.round(avgMonthlyDemand * 100) / 100,
      coefficientOfVariation: isFinite(coefficientOfVariation) ? Math.round(coefficientOfVariation * 100) / 100 : Infinity,
      xyzClass, combined: abcClass + xyzClass,
    });
  }

  return results;
}
