import type { CanonicalVoucher, CanonicalItem } from "../types/canonical";

export interface PartyOrderPattern {
  partyLedgerId: string;
  partyName: string;
  orderDates: string[];              // ISO dates of past orders
  avgIntervalDays: number;           // average days between orders
  stdDevDays: number;                // standard deviation
  lastOrderDate: string;             // most recent order
  predictedNextDate: string;         // predicted next order date
  confidence: number;                // 0-1 confidence score
  daysUntilPredicted: number;        // days from today to predicted
  isOverdue: boolean;                // past predicted date?
  topItems: PartyItemPrediction[];   // predicted items
}

export interface PartyItemPrediction {
  itemId: string;
  itemName: string;
  frequency: number;       // how many times ordered by this party
  avgQtyBase: number;      // average quantity per order
  lastQtyBase: number;     // quantity in last order
  predictedQtyBase: number;// predicted quantity
  trend: "up" | "down" | "stable"; // qty trend
}

export interface PredictionSnapshot {
  generatedAt: string;
  predictions: PartyOrderPattern[];
}

export interface PredictionAccuracy {
  partyLedgerId: string;
  partyName: string;
  predictedDate: string;
  actualDate: string | null;
  dateDiffDays: number | null;
  predictedItems: { itemId: string; predictedQty: number; actualQty: number }[];
  dateAccuracyScore: number;   // 0-1
  itemAccuracyScore: number;   // 0-1
}

/**
 * Build order predictions for all parties based on historical purchase/sales patterns.
 */
export function generatePredictions(
  vouchers: CanonicalVoucher[],
  items: Map<string, CanonicalItem>,
  voucherType: "Sales" | "Purchase" = "Sales"
): PartyOrderPattern[] {
  // Group vouchers by party
  const partyOrders = new Map<string, CanonicalVoucher[]>();

  for (const v of vouchers) {
    if (v.voucherType !== voucherType || v.isCancelled || v.isOptional) continue;
    if (!v.partyLedgerId) continue;

    let arr = partyOrders.get(v.partyLedgerId);
    if (!arr) { arr = []; partyOrders.set(v.partyLedgerId, arr); }
    arr.push(v);
  }

  const predictions: PartyOrderPattern[] = [];
  const today = new Date();

  for (const [partyId, orders] of partyOrders) {
    if (orders.length < 2) continue; // need at least 2 orders to predict

    // Sort by date
    const sorted = [...orders].sort((a, b) => a.date.localeCompare(b.date));
    const dates = sorted.map(v => v.date);

    // Calculate intervals
    const intervals: number[] = [];
    for (let i = 1; i < dates.length; i++) {
      const diff = daysBetween(dates[i - 1], dates[i]);
      if (diff > 0) intervals.push(diff);
    }

    if (intervals.length === 0) continue;

    const avgInterval = intervals.reduce((s, d) => s + d, 0) / intervals.length;
    const stdDev = Math.sqrt(
      intervals.reduce((s, d) => s + (d - avgInterval) ** 2, 0) / intervals.length
    );

    const lastDate = dates[dates.length - 1];
    const predictedNext = addDays(lastDate, Math.round(avgInterval));
    const daysUntil = daysBetween(today.toISOString().slice(0, 10), predictedNext);

    // Confidence: higher with more data points and lower variance
    const dataConfidence = Math.min(orders.length / 10, 1); // maxes at 10 orders
    const consistencyConfidence = avgInterval > 0 ? Math.max(0, 1 - (stdDev / avgInterval)) : 0;
    const confidence = Math.round((dataConfidence * 0.4 + consistencyConfidence * 0.6) * 100) / 100;

    // Top items for this party
    const itemAgg = new Map<string, { qty: number[]; count: number; name: string }>();
    for (const v of sorted) {
      for (const line of v.lines) {
        if (line.type !== "inventory" || !line.itemId) continue;
        let agg = itemAgg.get(line.itemId);
        if (!agg) {
          const item = items.get(line.itemId);
          agg = { qty: [], count: 0, name: item?.name ?? line.itemId };
          itemAgg.set(line.itemId, agg);
        }
        agg.qty.push(line.qtyBase ?? 0);
        agg.count++;
      }
    }

    const topItems: PartyItemPrediction[] = Array.from(itemAgg.entries())
      .map(([itemId, agg]) => {
        const avgQty = agg.qty.reduce((s, q) => s + q, 0) / agg.qty.length;
        const lastQty = agg.qty[agg.qty.length - 1] ?? 0;
        // Simple trend: compare last half avg vs first half avg
        const mid = Math.floor(agg.qty.length / 2);
        const firstHalf = agg.qty.slice(0, mid);
        const secondHalf = agg.qty.slice(mid);
        const firstAvg = firstHalf.length ? firstHalf.reduce((s, q) => s + q, 0) / firstHalf.length : avgQty;
        const secondAvg = secondHalf.length ? secondHalf.reduce((s, q) => s + q, 0) / secondHalf.length : avgQty;
        const trendRatio = firstAvg > 0 ? secondAvg / firstAvg : 1;
        const trend: "up" | "down" | "stable" = trendRatio > 1.15 ? "up" : trendRatio < 0.85 ? "down" : "stable";
        // Predicted qty: weighted toward recent + trend
        const predictedQty = Math.round(avgQty * (trend === "up" ? 1.1 : trend === "down" ? 0.9 : 1));

        return {
          itemId,
          itemName: agg.name,
          frequency: agg.count,
          avgQtyBase: Math.round(avgQty),
          lastQtyBase: lastQty,
          predictedQtyBase: predictedQty,
          trend,
        };
      })
      .sort((a, b) => b.frequency - a.frequency)
      .slice(0, 10);

    predictions.push({
      partyLedgerId: partyId,
      partyName: sorted[0].partyName ?? partyId,
      orderDates: dates,
      avgIntervalDays: Math.round(avgInterval),
      stdDevDays: Math.round(stdDev),
      lastOrderDate: lastDate,
      predictedNextDate: predictedNext,
      confidence,
      daysUntilPredicted: daysUntil,
      isOverdue: daysUntil < 0,
      topItems,
    });
  }

  return predictions.sort((a, b) => a.daysUntilPredicted - b.daysUntilPredicted);
}

/**
 * Score predictions against actual new data (Task 10)
 */
export function scorePredictions(
  previousPredictions: PartyOrderPattern[],
  newVouchers: CanonicalVoucher[],
  voucherType: "Sales" | "Purchase" = "Sales"
): PredictionAccuracy[] {
  const results: PredictionAccuracy[] = [];

  // Group new vouchers by party
  const newByParty = new Map<string, CanonicalVoucher[]>();
  for (const v of newVouchers) {
    if (v.voucherType !== voucherType || v.isCancelled) continue;
    if (!v.partyLedgerId) continue;
    let arr = newByParty.get(v.partyLedgerId);
    if (!arr) { arr = []; newByParty.set(v.partyLedgerId, arr); }
    arr.push(v);
  }

  for (const pred of previousPredictions) {
    const actuals = newByParty.get(pred.partyLedgerId);
    let actualDate: string | null = null;
    let dateDiff: number | null = null;
    let dateScore = 0;
    let itemScore = 0;

    const predictedItemMap: { itemId: string; predictedQty: number; actualQty: number }[] = [];

    if (actuals && actuals.length > 0) {
      // Find the first actual order after the last known order
      const sorted = [...actuals].sort((a, b) => a.date.localeCompare(b.date));
      const firstNew = sorted.find(v => v.date > pred.lastOrderDate);

      if (firstNew) {
        actualDate = firstNew.date;
        dateDiff = daysBetween(pred.predictedNextDate, actualDate);
        // Date accuracy: 1.0 if exact, decays with distance
        dateScore = Math.max(0, 1 - Math.abs(dateDiff) / (pred.avgIntervalDays || 30));
      }

      // Item accuracy
      const actualItemQty = new Map<string, number>();
      for (const v of actuals) {
        for (const line of v.lines) {
          if (line.type !== "inventory" || !line.itemId) continue;
          actualItemQty.set(line.itemId, (actualItemQty.get(line.itemId) ?? 0) + (line.qtyBase ?? 0));
        }
      }

      let totalError = 0;
      let totalPredicted = 0;
      for (const predItem of pred.topItems) {
        const actualQty = actualItemQty.get(predItem.itemId) ?? 0;
        predictedItemMap.push({ itemId: predItem.itemId, predictedQty: predItem.predictedQtyBase, actualQty });
        totalError += Math.abs(predItem.predictedQtyBase - actualQty);
        totalPredicted += predItem.predictedQtyBase;
      }
      itemScore = totalPredicted > 0 ? Math.max(0, 1 - totalError / totalPredicted) : 0;
    }

    results.push({
      partyLedgerId: pred.partyLedgerId,
      partyName: pred.partyName,
      predictedDate: pred.predictedNextDate,
      actualDate,
      dateDiffDays: dateDiff,
      predictedItems: predictedItemMap,
      dateAccuracyScore: Math.round(dateScore * 100) / 100,
      itemAccuracyScore: Math.round(itemScore * 100) / 100,
    });
  }

  return results;
}

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000);
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
