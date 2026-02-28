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
  upsellItems: UpsellSuggestion[];   // cross-sell / upsell suggestions
}

export interface PartyItemPrediction {
  itemId: string;
  itemName: string;
  frequency: number;       // how many times ordered by this party
  avgQtyBase: number;      // average quantity per order
  lastQtyBase: number;     // quantity in last order
  predictedQtyBase: number;// predicted quantity (rounded to package)
  trend: "up" | "down" | "stable"; // qty trend
}

export interface UpsellSuggestion {
  itemId: string;
  itemName: string;
  reason: string;           // "Frequently bought by similar parties" | "Trending item in category" | "Seasonal peak"
  suggestedQtyBase: number; // rounded to nearest unitsPerPkg
  confidence: number;       // 0-1
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

/** Round qty UP to nearest whole package */
function roundToPackage(qty: number, unitsPerPkg: number): number {
  if (unitsPerPkg <= 1) return Math.ceil(qty);
  return Math.ceil(qty / unitsPerPkg) * unitsPerPkg;
}

/**
 * Build order predictions for all parties based on historical purchase/sales patterns.
 * Enhanced with EWMA intervals, aggressive multipliers, upsell generation, and package rounding.
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

  // Pre-compute data needed for upsell analysis
  // partyItemSets: partyId -> Set<itemId>
  const partyItemSets = new Map<string, Set<string>>();
  // itemTotalQty: itemId -> total qty sold across ALL parties (for trending)
  const itemTotalQty = new Map<string, number>();
  // itemGroupQty: group -> Map<itemId, totalQty> (for category fill)
  const itemGroupQty = new Map<string, Map<string, number>>();
  // itemPartyAvgQty: itemId -> average qty per party order (for upsell suggested qty)
  const itemPartyQtys = new Map<string, number[]>();

  // Compute monthly totals for trending analysis
  const now = new Date();
  const threeMonthsAgo = new Date(now);
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
  const twelveMonthsAgo = new Date(now);
  twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);
  const threeMonthsAgoStr = threeMonthsAgo.toISOString().slice(0, 10);
  const twelveMonthsAgoStr = twelveMonthsAgo.toISOString().slice(0, 10);
  const nineMonthsAgo = new Date(now);
  nineMonthsAgo.setMonth(nineMonthsAgo.getMonth() - 12); // start of "prior 9 months" is 12 months ago

  // itemRecent3moQty and itemPrior9moQty for trending
  const itemRecent3moQty = new Map<string, number>();
  const itemPrior9moQty = new Map<string, number>();

  for (const v of vouchers) {
    if (v.voucherType !== voucherType || v.isCancelled || v.isOptional) continue;
    if (!v.partyLedgerId) continue;

    let partyItems = partyItemSets.get(v.partyLedgerId);
    if (!partyItems) { partyItems = new Set(); partyItemSets.set(v.partyLedgerId, partyItems); }

    for (const line of v.lines) {
      if (line.type !== "inventory" || !line.itemId) continue;
      partyItems.add(line.itemId);
      const qty = line.qtyBase ?? 0;

      // Total qty for all time
      itemTotalQty.set(line.itemId, (itemTotalQty.get(line.itemId) ?? 0) + qty);

      // Party qty tracking for avg
      let pqArr = itemPartyQtys.get(line.itemId);
      if (!pqArr) { pqArr = []; itemPartyQtys.set(line.itemId, pqArr); }
      pqArr.push(qty);

      // Group-level tracking
      const item = items.get(line.itemId);
      if (item) {
        let gm = itemGroupQty.get(item.group);
        if (!gm) { gm = new Map(); itemGroupQty.set(item.group, gm); }
        gm.set(line.itemId, (gm.get(line.itemId) ?? 0) + qty);
      }

      // Trending: recent 3 months vs prior 9 months
      if (v.date >= threeMonthsAgoStr) {
        itemRecent3moQty.set(line.itemId, (itemRecent3moQty.get(line.itemId) ?? 0) + qty);
      } else if (v.date >= twelveMonthsAgoStr && v.date < threeMonthsAgoStr) {
        itemPrior9moQty.set(line.itemId, (itemPrior9moQty.get(line.itemId) ?? 0) + qty);
      }
    }
  }

  // Identify trending items: last 3 months qty > 1.5x avg monthly of prior 9 months
  const trendingItems = new Set<string>();
  for (const [itemId, recent3] of itemRecent3moQty) {
    const prior9 = itemPrior9moQty.get(itemId) ?? 0;
    const avgMonthlyPrior = prior9 / 9;
    const avgMonthlyRecent = recent3 / 3;
    if (avgMonthlyPrior > 0 && avgMonthlyRecent > 1.5 * avgMonthlyPrior) {
      trendingItems.add(itemId);
    }
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

    // EWMA interval calculation (Task 3A)
    const alpha = 0.3;
    let ewma = intervals[0];
    for (let i = 1; i < intervals.length; i++) {
      ewma = alpha * intervals[i] + (1 - alpha) * ewma;
    }
    // Apply aggression factor: reduce by 15% to encourage faster reorders
    const aggressiveInterval = Math.max(1, Math.round(ewma * 0.85));

    const simpleAvg = intervals.reduce((s, d) => s + d, 0) / intervals.length;
    const stdDev = Math.sqrt(
      intervals.reduce((s, d) => s + (d - simpleAvg) ** 2, 0) / intervals.length
    );

    const lastDate = dates[dates.length - 1];
    const predictedNext = addDays(lastDate, aggressiveInterval);
    const daysUntil = daysBetween(today.toISOString().slice(0, 10), predictedNext);

    // Enhanced confidence (Task 3F)
    const dataConfidence = Math.min(orders.length / 8, 1);      // was /10
    const consistencyConfidence = simpleAvg > 0 ? Math.max(0, 1 - (stdDev / simpleAvg) * 0.7) : 0; // less harsh penalty
    const recencyBonus = daysUntil <= 7 ? 0.1 : daysUntil <= 30 ? 0.05 : 0;
    const confidence = Math.min(1, Math.round((dataConfidence * 0.35 + consistencyConfidence * 0.55 + recencyBonus + 0.05) * 100) / 100); // 5% floor boost

    // Top items for this party (Task 3B: increase from 10 to 15)
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

        // Aggressive multipliers (Task 3B/6)
        const trendMultiplier = trend === "up" ? 1.2 : trend === "down" ? 0.95 : 1.05;
        let predictedQty = Math.round(avgQty * trendMultiplier);

        // Round to package units (Task 3D)
        const item = items.get(itemId);
        if (item) {
          predictedQty = roundToPackage(predictedQty, item.unitsPerPkg);
        }

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
      .slice(0, 15); // was 10

    // Upsell suggestions (Task 3C)
    const upsellItems = generateUpsellSuggestions(
      partyId, partyItemSets, itemGroupQty, trendingItems,
      itemPartyQtys, items
    );

    predictions.push({
      partyLedgerId: partyId,
      partyName: sorted[0].partyName ?? partyId,
      orderDates: dates,
      avgIntervalDays: Math.round(simpleAvg),
      stdDevDays: Math.round(stdDev),
      lastOrderDate: lastDate,
      predictedNextDate: predictedNext,
      confidence,
      daysUntilPredicted: daysUntil,
      isOverdue: daysUntil < 0,
      topItems,
      upsellItems,
    });
  }

  return predictions.sort((a, b) => a.daysUntilPredicted - b.daysUntilPredicted);
}

/**
 * Generate upsell/cross-sell suggestions for a party (Task 3C).
 */
function generateUpsellSuggestions(
  partyId: string,
  partyItemSets: Map<string, Set<string>>,
  itemGroupQty: Map<string, Map<string, number>>,
  trendingItems: Set<string>,
  itemPartyQtys: Map<string, number[]>,
  items: Map<string, CanonicalItem>,
): UpsellSuggestion[] {
  const partyItems = partyItemSets.get(partyId);
  if (!partyItems || partyItems.size === 0) return [];

  const suggestions: UpsellSuggestion[] = [];
  const suggestedIds = new Set<string>();

  // 1. Co-purchase analysis: find parties with >= 50% overlap
  const coPartyItems = new Map<string, number>(); // itemId -> count of co-purchasing parties that buy it
  let coPurchaserCount = 0;

  for (const [otherPartyId, otherItems] of partyItemSets) {
    if (otherPartyId === partyId) continue;
    // Check overlap
    let overlap = 0;
    for (const itemId of partyItems) {
      if (otherItems.has(itemId)) overlap++;
    }
    const overlapRatio = partyItems.size > 0 ? overlap / partyItems.size : 0;
    if (overlapRatio >= 0.5) {
      coPurchaserCount++;
      // Find items they buy that this party doesn't
      for (const itemId of otherItems) {
        if (!partyItems.has(itemId)) {
          coPartyItems.set(itemId, (coPartyItems.get(itemId) ?? 0) + 1);
        }
      }
    }
  }

  // Top 3 co-purchase items
  if (coPurchaserCount > 0) {
    const coSorted = Array.from(coPartyItems.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);
    for (const [itemId, count] of coSorted) {
      if (suggestedIds.has(itemId)) continue;
      suggestedIds.add(itemId);
      const item = items.get(itemId);
      const avgQty = getAvgPartyQty(itemId, itemPartyQtys);
      const suggestedQty = item ? roundToPackage(avgQty, item.unitsPerPkg) : Math.ceil(avgQty);
      suggestions.push({
        itemId,
        itemName: item?.name ?? itemId,
        reason: "Frequently bought by similar parties",
        suggestedQtyBase: suggestedQty,
        confidence: Math.min(1, count / coPurchaserCount),
      });
    }
  }

  // 2. Category fill: if party buys from a group but not the top item in that group
  const partyGroups = new Set<string>();
  for (const itemId of partyItems) {
    const item = items.get(itemId);
    if (item) partyGroups.add(item.group);
  }
  for (const group of partyGroups) {
    const groupItems = itemGroupQty.get(group);
    if (!groupItems) continue;
    // Find top item in this group by qty
    let topItemId = "";
    let topQty = 0;
    for (const [itemId, qty] of groupItems) {
      if (qty > topQty) { topItemId = itemId; topQty = qty; }
    }
    if (topItemId && !partyItems.has(topItemId) && !suggestedIds.has(topItemId)) {
      suggestedIds.add(topItemId);
      const item = items.get(topItemId);
      const avgQty = getAvgPartyQty(topItemId, itemPartyQtys);
      const suggestedQty = item ? roundToPackage(avgQty, item.unitsPerPkg) : Math.ceil(avgQty);
      suggestions.push({
        itemId: topItemId,
        itemName: item?.name ?? topItemId,
        reason: "Trending item in category",
        suggestedQtyBase: suggestedQty,
        confidence: 0.5,
      });
    }
  }

  // 3. Trending items the party doesn't buy (top 2)
  let trendingAdded = 0;
  for (const itemId of trendingItems) {
    if (trendingAdded >= 2) break;
    if (partyItems.has(itemId) || suggestedIds.has(itemId)) continue;
    suggestedIds.add(itemId);
    const item = items.get(itemId);
    const avgQty = getAvgPartyQty(itemId, itemPartyQtys);
    const suggestedQty = item ? roundToPackage(avgQty, item.unitsPerPkg) : Math.ceil(avgQty);
    suggestions.push({
      itemId,
      itemName: item?.name ?? itemId,
      reason: "Seasonal peak",
      suggestedQtyBase: suggestedQty,
      confidence: 0.4,
    });
    trendingAdded++;
  }

  // Cap at 5 upsell items
  return suggestions.slice(0, 5);
}

/** Get average quantity that parties order for an item */
function getAvgPartyQty(itemId: string, itemPartyQtys: Map<string, number[]>): number {
  const qtys = itemPartyQtys.get(itemId);
  if (!qtys || qtys.length === 0) return 1;
  return qtys.reduce((s, q) => s + q, 0) / qtys.length;
}

/**
 * Score predictions against actual new data
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
