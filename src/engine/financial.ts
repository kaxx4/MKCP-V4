import type { CanonicalVoucher, CanonicalItem } from "../types/canonical";

export interface ItemMarginData {
  itemId: string;
  name: string;
  group: string;
  baseUnit: string;
  totalPurchaseQty: number;
  totalPurchaseValue: number;
  avgPurchaseRate: number;
  totalSalesQty: number;
  totalSalesValue: number;
  avgSalesRate: number;
  marginPerUnit: number;
  marginPct: number;
  totalProfit: number;
  hasNoSales: boolean;
  hasNoPurchases: boolean;
}

export function computeItemMargins(
  items: Map<string, CanonicalItem>,
  vouchers: CanonicalVoucher[],
  periodMonths?: number
): ItemMarginData[] {
  // Determine startDate if periodMonths is provided
  let startDate: string | null = null;
  if (periodMonths !== undefined) {
    let latestDate = "";
    for (const v of vouchers) {
      if (v.date > latestDate) latestDate = v.date;
    }
    if (latestDate) {
      const d = new Date(latestDate);
      d.setMonth(d.getMonth() - periodMonths);
      startDate = d.toISOString().slice(0, 10);
    }
  }

  // Accumulate sales and purchase totals per item — single pass
  const salesQty = new Map<string, number>();
  const salesValue = new Map<string, number>();
  const purchaseQty = new Map<string, number>();
  const purchaseValue = new Map<string, number>();

  for (const v of vouchers) {
    if (v.isCancelled || v.isOptional) continue;
    if (startDate && v.date < startDate) continue;
    // Include Sales, Purchase, Credit Note (sales return), Debit Note (purchase return)
    const isSalesSide = v.voucherType === "Sales" || v.voucherType === "Credit Note";
    const isPurchaseSide = v.voucherType === "Purchase" || v.voucherType === "Debit Note";
    if (!isSalesSide && !isPurchaseSide) continue;
    // Returns subtract from totals
    const sign = (v.voucherType === "Credit Note" || v.voucherType === "Debit Note") ? -1 : 1;

    for (const line of v.lines) {
      if (line.type !== "inventory" || !line.itemId) continue;
      const qty = (line.qtyBase ?? 0) * sign;
      const value = (line.lineAmount ?? 0) * sign;

      if (isSalesSide) {
        salesQty.set(line.itemId, (salesQty.get(line.itemId) ?? 0) + qty);
        salesValue.set(line.itemId, (salesValue.get(line.itemId) ?? 0) + value);
      } else {
        purchaseQty.set(line.itemId, (purchaseQty.get(line.itemId) ?? 0) + qty);
        purchaseValue.set(line.itemId, (purchaseValue.get(line.itemId) ?? 0) + value);
      }
    }
  }

  // Build result for each item
  const results: ItemMarginData[] = [];
  for (const [itemId, item] of items) {
    const totalPurchaseQty = purchaseQty.get(itemId) ?? 0;
    const totalPurchaseValue = purchaseValue.get(itemId) ?? 0;
    const totalSalesQty = salesQty.get(itemId) ?? 0;
    const totalSalesValue = salesValue.get(itemId) ?? 0;

    let avgPurchaseRate = totalPurchaseQty > 0 ? totalPurchaseValue / totalPurchaseQty : 0;
    const avgSalesRate = totalSalesQty > 0 ? totalSalesValue / totalSalesQty : 0;

    // Fallback: if no purchases but has sales, use item openingRate
    if (avgPurchaseRate === 0 && totalSalesQty > 0) {
      avgPurchaseRate = item.openingRate;
    }

    const marginPerUnit = avgSalesRate - avgPurchaseRate;
    const marginPct = avgSalesRate > 0 ? (marginPerUnit / avgSalesRate) * 100 : 0;
    // Total profit uses min(sales, purchase) to calculate profit only on matched inventory (conservative approach)
    // This accounts for the fact that we can't have sold more than we purchased (excluding opening stock)
    const totalProfit = marginPerUnit * Math.min(totalSalesQty, totalPurchaseQty);

    results.push({
      itemId,
      name: item.name,
      group: item.group,
      baseUnit: item.baseUnit,
      totalPurchaseQty,
      totalPurchaseValue,
      avgPurchaseRate,
      totalSalesQty,
      totalSalesValue,
      avgSalesRate,
      marginPerUnit,
      marginPct,
      totalProfit,
      hasNoSales: totalSalesQty === 0,
      hasNoPurchases: totalPurchaseQty === 0,
    });
  }

  return results;
}
