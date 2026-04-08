/**
 * Period-Based Inventory Calculations
 * Calculates Opening, Inwards, Outwards, Closing for a selected period
 * Also computes aggressive suggested reorder quantities
 */

import type { CanonicalItem, CanonicalVoucher, MonthBucket } from "../types/canonical";
import { computeMonthlyBuckets } from "../engine/inventory";

export interface PeriodInventoryData {
  opening: number; // Opening stock for period
  inwards: number; // Total inwards in period
  outwards: number; // Total outwards in period
  closing: number; // Closing stock for period
  avgMonthlyOut: number; // Average monthly outwards
  suggestedQty: number; // Aggressive ceiling-rounded reorder quantity
  monthsOfStock: number; // Months remaining at current outward rate
  criticalLevel: number; // Reorder level = 2 months of stock
}

export interface PeriodRange {
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
}

/**
 * Calculate inventory data for a specific period
 */
export function calculatePeriodInventory(
  item: CanonicalItem,
  vouchers: CanonicalVoucher[],
  period: PeriodRange
): PeriodInventoryData {
  const startMonth = period.startDate.slice(0, 7); // YYYY-MM
  const endMonth = period.endDate.slice(0, 7); // YYYY-MM

  let opening = item.openingQtyBase;
  let inwards = 0;
  let outwards = 0;

  // Calculate movements within period
  for (const v of vouchers) {
    if (v.isCancelled || v.isOptional) continue;
    if (v.date < period.startDate || v.date > period.endDate) continue; // Outside period

    for (const line of v.lines) {
      if (line.type !== "inventory" || line.itemId !== item.itemId) continue;

      const qty = line.qtyBase ?? 0;
      if (v.voucherType === "Sales") {
        outwards += qty;
      } else if (v.voucherType === "Credit Note") {
        inwards += qty; // Sales return = inward
      } else if (v.voucherType === "Purchase") {
        inwards += qty;
      } else if (v.voucherType === "Debit Note") {
        outwards += qty; // Purchase return = outward
      } else if (v.voucherType === "Stock Journal" || v.voucherType === "Journal") {
        // Stock Journal and Journal can have +ve or -ve qty
        if (qty > 0) inwards += qty;
        else outwards += Math.abs(qty);
      }
    }
  }

  // For opening, need to sum all movements BEFORE period start
  for (const v of vouchers) {
    if (v.isCancelled || v.isOptional) continue;
    if (v.date >= period.startDate) continue; // Only before period

    for (const line of v.lines) {
      if (line.type !== "inventory" || line.itemId !== item.itemId) continue;

      const qty = line.qtyBase ?? 0;
      if (v.voucherType === "Sales") {
        opening -= qty;
      } else if (v.voucherType === "Credit Note") {
        opening += qty;
      } else if (v.voucherType === "Purchase") {
        opening += qty;
      } else if (v.voucherType === "Debit Note") {
        opening -= qty;
      } else if (v.voucherType === "Stock Journal" || v.voucherType === "Journal") {
        // Stock Journal and Journal can have +ve or -ve qty
        opening += qty;
      }
    }
  }

  const closing = opening + inwards - outwards;

  // Calculate average monthly outward for last 3 months before period
  const buckets = computeMonthlyBuckets(item, vouchers, 3);
  const avgMonthlyOut = buckets.length > 0
    ? buckets.reduce((sum, b) => sum + b.outwardsBase, 0) / buckets.length
    : 0;

  // Calculate months of stock remaining
  const monthsOfStock = avgMonthlyOut > 0 ? closing / avgMonthlyOut : Infinity;

  // Reorder level = 2 months of stock (safety level)
  const criticalLevel = Math.ceil(avgMonthlyOut * 2);

  // AGGRESSIVE suggested quantity: ceiling to next 10x or 100x depending on typical order size
  let suggestedQty = 0;
  if (closing < criticalLevel && avgMonthlyOut > 0) {
    // Need to order
    const deficit = criticalLevel - closing; // Bring to 2 months
    const orderQty = deficit + (avgMonthlyOut * 3); // Order 2 months extra for safety

    // Round UP aggressively to nearest ceiling
    if (orderQty < 100) {
      suggestedQty = Math.ceil(orderQty / 5) * 5; // Round to nearest 5
    } else if (orderQty < 500) {
      suggestedQty = Math.ceil(orderQty / 10) * 10; // Round to nearest 10
    } else if (orderQty < 5000) {
      suggestedQty = Math.ceil(orderQty / 50) * 50; // Round to nearest 50
    } else {
      suggestedQty = Math.ceil(orderQty / 100) * 100; // Round to nearest 100
    }
  }

  return {
    opening: Math.round(opening * 100) / 100,
    inwards: Math.round(inwards * 100) / 100,
    outwards: Math.round(outwards * 100) / 100,
    closing: Math.round(closing * 100) / 100,
    avgMonthlyOut: Math.round(avgMonthlyOut * 100) / 100,
    suggestedQty: Math.round(suggestedQty * 100) / 100,
    monthsOfStock: Math.round(monthsOfStock * 100) / 100,
    criticalLevel: Math.round(criticalLevel * 100) / 100
  };
}

/**
 * Get period range from month/date selection
 */
export function getPeriodRange(
  selectionType: "month" | "date_range",
  value: string | { start: string; end: string }
): PeriodRange {
  if (selectionType === "month") {
    const [year, month] = (value as string).split("-");
    const startDate = `${year}-${month}-01`;
    const lastDay = new Date(Number(year), Number(month), 0).getDate();
    const endDate = `${year}-${month}-${lastDay.toString().padStart(2, "0")}`;
    return { startDate, endDate };
  } else {
    const range = value as { start: string; end: string };
    return {
      startDate: range.start,
      endDate: range.end
    };
  }
}

/**
 * Determine severity level based on months of stock
 */
export function getInventorySeverity(
  monthsOfStock: number,
  suggestedQty: number
): "critical" | "low" | "reorder" | "ok" {
  if (monthsOfStock <= 0) return "critical"; // No stock
  if (monthsOfStock < 0.5) return "critical"; // Less than 2 weeks
  if (monthsOfStock < 1) return "low"; // Less than 1 month
  if (suggestedQty > 0) return "reorder"; // Suggested reorder pending
  return "ok"; // Good stock level
}

/**
 * Format period inventory for display
 */
export function formatPeriodInventory(data: PeriodInventoryData) {
  return {
    opening: data.opening.toFixed(2),
    inwards: data.inwards.toFixed(2),
    outwards: data.outwards.toFixed(2),
    closing: data.closing.toFixed(2),
    avgMonthlyOut: data.avgMonthlyOut.toFixed(2),
    suggestedQty: data.suggestedQty.toFixed(0), // As integer
    monthsOfStock:
      data.monthsOfStock === Infinity
        ? "∞"
        : data.monthsOfStock < 0
        ? "-"
        : data.monthsOfStock.toFixed(1),
    criticalLevel: data.criticalLevel.toFixed(2)
  };
}
