import type { CanonicalVoucher, CanonicalItem } from "../types/canonical";

// ─────────────────────────────────────────────────────────────────────
// Types — Party-level predictions
// ─────────────────────────────────────────────────────────────────────

export interface PartyOrderPattern {
  partyLedgerId: string;
  partyName: string;
  orderDates: string[];
  avgIntervalDays: number;
  stdDevDays: number;
  lastOrderDate: string;
  predictedNextDate: string;
  confidence: number;
  daysUntilPredicted: number;
  isOverdue: boolean;
  topItems: PartyItemPrediction[];
  upsellItems: UpsellSuggestion[];
  partyRevenue: number;
  partyTier: "platinum" | "gold" | "silver" | "bronze";
  seasonalityScore: number;
  orderConsistency: number;
}

export interface PartyItemPrediction {
  itemId: string;
  itemName: string;
  frequency: number;
  avgQtyBase: number;
  lastQtyBase: number;
  predictedQtyBase: number;
  trend: "up" | "down" | "stable";
  currentStock: number;
  daysOfStock: number;
  needsRestock: boolean;
  seasonalMultiplier: number;
  velocityClass: "fast" | "medium" | "slow" | "dead";
}

export interface UpsellSuggestion {
  itemId: string;
  itemName: string;
  reason: string;
  suggestedQtyBase: number;
  confidence: number;
}

// ─────────────────────────────────────────────────────────────────────
// Types — Item-level forecasts & inventory alerts
// ─────────────────────────────────────────────────────────────────────

export interface ItemForecast {
  itemId: string;
  itemName: string;
  group: string;
  currentStock: number;
  avgMonthlyDemand: number;
  avgMonthlySupply: number;
  demandTrend: "rising" | "falling" | "stable";
  seasonalFactors: number[];
  nextMonthForecast: number;
  next3MonthForecast: number;
  daysOfStockRemaining: number;
  reorderPoint: number;
  safetyStock: number;
  suggestedPurchaseQty: number;
  velocityClass: "fast" | "medium" | "slow" | "dead";
  abcClass: "A" | "B" | "C";
  stockHealthStatus: "critical" | "low" | "adequate" | "excess" | "dead";
  leadTimeDays: number;
}

export interface InventoryAlert {
  itemId: string;
  itemName: string;
  alertType: "stockout_imminent" | "reorder_now" | "excess_stock" | "dead_stock" | "demand_spike" | "demand_drop";
  severity: "critical" | "warning" | "info";
  message: string;
  currentStock: number;
  suggestedAction: string;
  metric: number;
}

// ─────────────────────────────────────────────────────────────────────
// Types — Snapshots & Accuracy
// ─────────────────────────────────────────────────────────────────────

export interface PredictionSnapshot {
  generatedAt: string;
  predictions: PartyOrderPattern[];
  itemForecasts?: ItemForecast[];
  inventoryAlerts?: InventoryAlert[];
}

export interface PredictionAccuracy {
  partyLedgerId: string;
  partyName: string;
  predictedDate: string;
  actualDate: string | null;
  dateDiffDays: number | null;
  predictedItems: { itemId: string; predictedQty: number; actualQty: number }[];
  dateAccuracyScore: number;
  itemAccuracyScore: number;
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function roundToPackage(qty: number, unitsPerPkg: number): number {
  if (unitsPerPkg <= 1) return Math.ceil(qty);
  return Math.ceil(qty / unitsPerPkg) * unitsPerPkg;
}

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000);
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function getMonthIndex(dateStr: string): number {
  const d = new Date(dateStr);
  return d.getMonth();
}

// ─────────────────────────────────────────────────────────────────────
// FEATURE 2A: Enhanced Party Predictions (generatePredictions)
// ─────────────────────────────────────────────────────────────────────

export function generatePredictions(
  vouchers: CanonicalVoucher[],
  items: Map<string, CanonicalItem>,
  voucherType: "Sales" | "Purchase" = "Sales"
): PartyOrderPattern[] {
  // Group vouchers by party
  const partyOrders = new Map<string, CanonicalVoucher[]>();
  const partyRevenues = new Map<string, number>();

  for (const v of vouchers) {
    if (v.voucherType !== voucherType || v.isCancelled || v.isOptional) continue;
    if (!v.partyLedgerId) continue;

    let arr = partyOrders.get(v.partyLedgerId);
    if (!arr) { arr = []; partyOrders.set(v.partyLedgerId, arr); }
    arr.push(v);

    // Accumulate revenue for tier calculation
    const voucherTotal = v.lines
      .filter(l => l.type === "ledger" && l.isDebit)
      .reduce((s, l) => s + (l.amount ?? 0), 0);
    partyRevenues.set(v.partyLedgerId, (partyRevenues.get(v.partyLedgerId) ?? 0) + voucherTotal);
  }

  // Compute revenue percentiles for tier assignment
  const allRevenues = Array.from(partyRevenues.values()).sort((a, b) => b - a);
  const p90 = allRevenues[Math.floor(allRevenues.length * 0.1)] ?? 0;
  const p75 = allRevenues[Math.floor(allRevenues.length * 0.25)] ?? 0;
  const p50 = allRevenues[Math.floor(allRevenues.length * 0.5)] ?? 0;

  function getPartyTier(revenue: number): "platinum" | "gold" | "silver" | "bronze" {
    if (revenue >= p90) return "platinum";
    if (revenue >= p75) return "gold";
    if (revenue >= p50) return "silver";
    return "bronze";
  }

  // Pre-compute data needed for upsell analysis
  const partyItemSets = new Map<string, Set<string>>();
  const itemTotalQty = new Map<string, number>();
  const itemGroupQty = new Map<string, Map<string, number>>();
  const itemPartyQtys = new Map<string, number[]>();

  const now = new Date();
  const threeMonthsAgo = new Date(now);
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
  const twelveMonthsAgo = new Date(now);
  twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);
  const threeMonthsAgoStr = threeMonthsAgo.toISOString().slice(0, 10);
  const twelveMonthsAgoStr = twelveMonthsAgo.toISOString().slice(0, 10);

  const itemRecent3moQty = new Map<string, number>();
  const itemPrior9moQty = new Map<string, number>();

  // Monthly demand per item for seasonal decomposition
  const itemMonthlyDemand = new Map<string, number[]>(); // itemId -> [12 months]

  // Item stock calculation (opening + purchases - sales)
  const itemStockMap = new Map<string, number>();

  for (const v of vouchers) {
    if (v.isCancelled || v.isOptional) continue;

    for (const line of v.lines) {
      if (line.type !== "inventory" || !line.itemId) continue;
      const qty = line.qtyBase ?? 0;

      // Stock tracking (all voucher types that affect inventory)
      if (v.voucherType === "Purchase") {
        itemStockMap.set(line.itemId, (itemStockMap.get(line.itemId) ?? 0) + qty);
      } else if (v.voucherType === "Sales") {
        itemStockMap.set(line.itemId, (itemStockMap.get(line.itemId) ?? 0) - qty);
      } else if (v.voucherType === "Credit Note") {
        // Sales return → goods come back in
        itemStockMap.set(line.itemId, (itemStockMap.get(line.itemId) ?? 0) + qty);
      } else if (v.voucherType === "Debit Note") {
        // Purchase return → goods go back out
        itemStockMap.set(line.itemId, (itemStockMap.get(line.itemId) ?? 0) - qty);
      } else if (v.voucherType === "Stock Journal") {
        // Stock Journal qty can be +ve (in) or -ve (out)
        itemStockMap.set(line.itemId, (itemStockMap.get(line.itemId) ?? 0) + qty);
      }

      // Only process target voucher type for predictions
      if (v.voucherType !== voucherType) continue;
      if (!v.partyLedgerId) continue;

      let partyItems = partyItemSets.get(v.partyLedgerId);
      if (!partyItems) { partyItems = new Set(); partyItemSets.set(v.partyLedgerId, partyItems); }
      partyItems.add(line.itemId);

      itemTotalQty.set(line.itemId, (itemTotalQty.get(line.itemId) ?? 0) + qty);

      let pqArr = itemPartyQtys.get(line.itemId);
      if (!pqArr) { pqArr = []; itemPartyQtys.set(line.itemId, pqArr); }
      pqArr.push(qty);

      const item = items.get(line.itemId);
      if (item) {
        let gm = itemGroupQty.get(item.group);
        if (!gm) { gm = new Map(); itemGroupQty.set(item.group, gm); }
        gm.set(line.itemId, (gm.get(line.itemId) ?? 0) + qty);
      }

      if (v.date >= threeMonthsAgoStr) {
        itemRecent3moQty.set(line.itemId, (itemRecent3moQty.get(line.itemId) ?? 0) + qty);
      } else if (v.date >= twelveMonthsAgoStr && v.date < threeMonthsAgoStr) {
        itemPrior9moQty.set(line.itemId, (itemPrior9moQty.get(line.itemId) ?? 0) + qty);
      }

      // Monthly demand accumulation
      const monthIdx = getMonthIndex(v.date);
      let monthly = itemMonthlyDemand.get(line.itemId);
      if (!monthly) { monthly = new Array(12).fill(0); itemMonthlyDemand.set(line.itemId, monthly); }
      monthly[monthIdx] += qty;
    }
  }

  // Add opening balances to stock
  for (const [, item] of items) {
    const opening = item.openingQtyBase ?? 0;
    if (opening > 0) {
      itemStockMap.set(item.itemId, (itemStockMap.get(item.itemId) ?? 0) + opening);
    }
  }

  // Compute seasonal multipliers per item (next month's factor)
  const nextMonth = (now.getMonth() + 1) % 12;
  function getSeasonalMultiplier(itemId: string): number {
    const monthly = itemMonthlyDemand.get(itemId);
    if (!monthly) return 1;
    const total = monthly.reduce((s, v) => s + v, 0);
    if (total === 0) return 1;
    const avg = total / 12;
    const nextMonthDemand = monthly[nextMonth];
    return avg > 0 ? nextMonthDemand / avg : 1;
  }

  // Velocity classification
  function getVelocityClass(itemId: string): "fast" | "medium" | "slow" | "dead" {
    const recent = itemRecent3moQty.get(itemId) ?? 0;
    const prior = itemPrior9moQty.get(itemId) ?? 0;
    const recentMonthly = recent / 3;
    const priorMonthly = prior / 9;
    if (recent === 0 && prior === 0) return "dead";
    if (recent === 0) return "slow";
    if (priorMonthly > 0 && recentMonthly > 1.5 * priorMonthly) return "fast";
    if (priorMonthly > 0 && recentMonthly < 0.5 * priorMonthly) return "slow";
    return "medium";
  }

  // Identify trending items
  const trendingItems = new Set<string>();
  for (const [itemId, recent3] of itemRecent3moQty) {
    const prior9 = itemPrior9moQty.get(itemId) ?? 0;
    const avgMonthlyPrior = prior9 / 9;
    const avgMonthlyRecent = recent3 / 3;
    if (avgMonthlyPrior > 0 && avgMonthlyRecent > 1.5 * avgMonthlyPrior) {
      trendingItems.add(itemId);
    }
  }

  // Build monthly order counts per party for seasonality scoring
  const partyMonthlyOrders = new Map<string, number[]>(); // partyId -> [12 months]

  for (const [partyId, orders] of partyOrders) {
    const monthlyCounts = new Array(12).fill(0);
    for (const v of orders) {
      monthlyCounts[getMonthIndex(v.date)]++;
    }
    partyMonthlyOrders.set(partyId, monthlyCounts);
  }

  const predictions: PartyOrderPattern[] = [];
  const today = new Date();

  for (const [partyId, orders] of partyOrders) {
    if (orders.length < 2) continue;

    const sorted = [...orders].sort((a, b) => a.date.localeCompare(b.date));
    const dates = sorted.map(v => v.date);

    const intervals: number[] = [];
    for (let i = 1; i < dates.length; i++) {
      const diff = daysBetween(dates[i - 1], dates[i]);
      if (diff > 0) intervals.push(diff);
    }

    if (intervals.length === 0) continue;

    // EWMA interval calculation — adaptive alpha based on data volume
    // More data → higher alpha (more responsive to recent changes)
    const alpha = Math.min(0.5, 0.2 + intervals.length * 0.02);
    let ewma = intervals[0];
    for (let i = 1; i < intervals.length; i++) {
      ewma = alpha * intervals[i] + (1 - alpha) * ewma;
    }

    const simpleAvg = intervals.reduce((s, d) => s + d, 0) / intervals.length;
    const stdDev = Math.sqrt(
      intervals.reduce((s, d) => s + (d - simpleAvg) ** 2, 0) / intervals.length
    );

    // Order consistency (inverse CV)
    const cv = simpleAvg > 0 ? stdDev / simpleAvg : 1;
    const orderConsistency = Math.max(0, Math.min(1, 1 - cv));

    // Seasonal interval adjustment
    const seasonalMultiplierForParty = getPartySeasonalFactor(partyId, partyMonthlyOrders, nextMonth);
    const seasonAdjustedInterval = seasonalMultiplierForParty > 0
      ? ewma / seasonalMultiplierForParty
      : ewma;

    // Apply aggression factor — scale by order consistency
    // High consistency (regular orders) → tighter window (0.95), low consistency → wider (0.80)
    const aggressionFactor = 0.80 + orderConsistency * 0.15; // range: 0.80 to 0.95
    const aggressiveInterval = Math.max(1, Math.round(seasonAdjustedInterval * aggressionFactor));

    // Seasonality score for this party
    const monthlyCounts = partyMonthlyOrders.get(partyId) ?? new Array(12).fill(0);
    const monthlyTotal = monthlyCounts.reduce((s: number, v: number) => s + v, 0);
    const monthlyAvg = monthlyTotal / 12;
    const monthlyStd = monthlyAvg > 0
      ? Math.sqrt(monthlyCounts.reduce((s: number, v: number) => s + (v - monthlyAvg) ** 2, 0) / 12)
      : 0;
    const seasonalityScore = monthlyAvg > 0 ? Math.min(1, monthlyStd / monthlyAvg) : 0;

    const lastDate = dates[dates.length - 1];
    const predictedNext = addDays(lastDate, aggressiveInterval);
    const daysUntil = daysBetween(today.toISOString().slice(0, 10), predictedNext);

    // Revenue and tier
    const revenue = partyRevenues.get(partyId) ?? 0;
    const tier = getPartyTier(revenue);

    // Enhanced confidence
    const dataConfidence = Math.min(orders.length / 8, 1);
    const consistencyConfidence = simpleAvg > 0 ? Math.max(0, 1 - (stdDev / simpleAvg) * 0.7) : 0;
    const recencyBonus = daysUntil <= 7 ? 0.1 : daysUntil <= 30 ? 0.05 : 0;
    const confidence = Math.min(1, Math.round((dataConfidence * 0.35 + consistencyConfidence * 0.55 + recencyBonus + 0.05) * 100) / 100);

    // Top items (increased to 20)
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

        const mid = Math.floor(agg.qty.length / 2);
        const firstHalf = agg.qty.slice(0, mid);
        const secondHalf = agg.qty.slice(mid);
        const firstAvg = firstHalf.length ? firstHalf.reduce((s, q) => s + q, 0) / firstHalf.length : avgQty;
        const secondAvg = secondHalf.length ? secondHalf.reduce((s, q) => s + q, 0) / secondHalf.length : avgQty;
        const trendRatio = firstAvg > 0 ? secondAvg / firstAvg : 1;
        const trend: "up" | "down" | "stable" = trendRatio > 1.15 ? "up" : trendRatio < 0.85 ? "down" : "stable";

        const trendMultiplier = trend === "up" ? 1.2 : trend === "down" ? 0.95 : 1.05;
        const seasonalMult = getSeasonalMultiplier(itemId);
        let predictedQty = Math.round(avgQty * trendMultiplier * Math.max(0.5, Math.min(2, seasonalMult)));

        const item = items.get(itemId);
        if (item) {
          predictedQty = roundToPackage(predictedQty, item.unitsPerPkg);
        }

        // Stock-aware fields
        const stock = itemStockMap.get(itemId) ?? 0;
        const recent3 = itemRecent3moQty.get(itemId) ?? 0;
        const avgMonthlyDemand = recent3 / 3;
        const daysOfStock = avgMonthlyDemand > 0 ? Math.round((stock / avgMonthlyDemand) * 30) : stock > 0 ? 999 : 0;
        const velocityClass = getVelocityClass(itemId);

        return {
          itemId,
          itemName: agg.name,
          frequency: agg.count,
          avgQtyBase: Math.round(avgQty),
          lastQtyBase: lastQty,
          predictedQtyBase: predictedQty,
          trend,
          currentStock: Math.round(stock),
          daysOfStock,
          needsRestock: daysOfStock < 30 && avgMonthlyDemand > 0,
          seasonalMultiplier: Math.round(seasonalMult * 100) / 100,
          velocityClass,
        };
      })
      .sort((a, b) => b.frequency - a.frequency)
      .slice(0, 20);

    // Upsell suggestions
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
      partyRevenue: Math.round(revenue),
      partyTier: tier,
      seasonalityScore: Math.round(seasonalityScore * 100) / 100,
      orderConsistency: Math.round(orderConsistency * 100) / 100,
    });
  }

  return predictions.sort((a, b) => a.daysUntilPredicted - b.daysUntilPredicted);
}

// ─────────────────────────────────────────────────────────────────────
// Party seasonal factor helper
// ─────────────────────────────────────────────────────────────────────

function getPartySeasonalFactor(
  partyId: string,
  partyMonthlyOrders: Map<string, number[]>,
  targetMonth: number
): number {
  const counts = partyMonthlyOrders.get(partyId);
  if (!counts) return 1;
  const total = counts.reduce((s, v) => s + v, 0);
  if (total === 0) return 1;
  const avg = total / 12;
  const targetCount = counts[targetMonth];
  return avg > 0 ? targetCount / avg : 1;
}

// ─────────────────────────────────────────────────────────────────────
// Upsell Suggestions
// ─────────────────────────────────────────────────────────────────────

function generateUpsellSuggestions(
  partyId: string,
  partyItemSets: Map<string, Set<string>>,
  itemGroupQty: Map<string, Map<string, number>>,
  trendingItems: Set<string>,
  itemPartyQtys: Map<string, number[]>,
  items: Map<string, CanonicalItem>,
): UpsellSuggestion[] {
  const partyItems = partyItemSets.get(partyId) ?? new Set<string>();
  const suggestions: UpsellSuggestion[] = [];
  const suggestedIds = new Set<string>();

  // 1. Co-purchase analysis
  const coPartyItems = new Map<string, number>();
  let coPurchaserCount = 0;

  for (const [otherPartyId, otherItems] of partyItemSets) {
    if (otherPartyId === partyId) continue;
    let overlap = 0;
    for (const itemId of partyItems) {
      if (otherItems.has(itemId)) overlap++;
    }
    const overlapRatio = partyItems.size > 0 ? overlap / partyItems.size : 0.3;
    if (overlapRatio >= 0.3) {
      coPurchaserCount++;
      for (const itemId of otherItems) {
        if (!partyItems.has(itemId)) {
          coPartyItems.set(itemId, (coPartyItems.get(itemId) ?? 0) + 1);
        }
      }
    }
  }

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

  // 2. Category fill
  const partyGroups = new Set<string>();
  for (const itemId of partyItems) {
    const item = items.get(itemId);
    if (item) partyGroups.add(item.group);
  }
  for (const group of partyGroups) {
    const groupItems = itemGroupQty.get(group);
    if (!groupItems) continue;
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

  // 3. Trending items
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

  return suggestions.slice(0, 5);
}

function getAvgPartyQty(itemId: string, itemPartyQtys: Map<string, number[]>): number {
  const qtys = itemPartyQtys.get(itemId);
  if (!qtys || qtys.length === 0) return 1;
  return qtys.reduce((s, q) => s + q, 0) / qtys.length;
}

// ─────────────────────────────────────────────────────────────────────
// FEATURE 2B: Item-Level Demand Forecasting (generateItemForecasts)
// ─────────────────────────────────────────────────────────────────────

export function generateItemForecasts(
  vouchers: CanonicalVoucher[],
  items: Map<string, CanonicalItem>,
): { forecasts: ItemForecast[]; alerts: InventoryAlert[] } {
  const now = new Date();
  const currentMonth = now.getMonth();
  const DEFAULT_LEAD_TIME = 7; // days

  // Build monthly demand/supply arrays per item (last 12 months)
  const itemMonthlyDemand = new Map<string, number[]>(); // [0..11] indexed by calendar month
  const itemMonthlySales = new Map<string, number[]>(); // recent 12 months for WMA
  const itemMonthlyPurchases = new Map<string, number[]>();
  const itemTotalRevenue = new Map<string, number>();

  // Track which months have data
  const twelveMonthsAgo = new Date(now);
  twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);
  const twelveMonthsAgoStr = twelveMonthsAgo.toISOString().slice(0, 10);

  // Monthly buckets for recent 12 months (index 0 = 12 months ago, 11 = current month)
  function getRecentMonthIndex(dateStr: string): number {
    const d = new Date(dateStr);
    const monthsDiff = (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth());
    return 11 - monthsDiff; // 0 = oldest, 11 = current
  }

  // Initialize data structures for all items
  for (const [itemId, item] of items) {
    itemMonthlyDemand.set(itemId, new Array(12).fill(0));
    itemMonthlySales.set(itemId, new Array(12).fill(0));
    itemMonthlyPurchases.set(itemId, new Array(12).fill(0));
  }

  // Track ALL voucher movements for accurate stock (not limited to 12 months)
  const itemAllTimePurchases = new Map<string, number>();
  const itemAllTimeSales = new Map<string, number>();
  const itemAllTimeCreditNotes = new Map<string, number>();
  const itemAllTimeDebitNotes = new Map<string, number>();
  const itemAllTimeStockJournals = new Map<string, number>();

  // Accumulate voucher data
  for (const v of vouchers) {
    if (v.isCancelled || v.isOptional) continue;

    for (const line of v.lines) {
      if (line.type !== "inventory" || !line.itemId) continue;
      if (!items.has(line.itemId)) continue;

      const qty = line.qtyBase ?? 0;
      const rate = line.ratePerBase ?? 0;

      // All-time stock tracking (every voucher regardless of date)
      if (v.voucherType === "Purchase") {
        itemAllTimePurchases.set(line.itemId, (itemAllTimePurchases.get(line.itemId) ?? 0) + qty);
      } else if (v.voucherType === "Sales") {
        itemAllTimeSales.set(line.itemId, (itemAllTimeSales.get(line.itemId) ?? 0) + qty);
      } else if (v.voucherType === "Credit Note") {
        itemAllTimeCreditNotes.set(line.itemId, (itemAllTimeCreditNotes.get(line.itemId) ?? 0) + qty);
      } else if (v.voucherType === "Debit Note") {
        itemAllTimeDebitNotes.set(line.itemId, (itemAllTimeDebitNotes.get(line.itemId) ?? 0) + qty);
      } else if (v.voucherType === "Stock Journal") {
        itemAllTimeStockJournals.set(line.itemId, (itemAllTimeStockJournals.get(line.itemId) ?? 0) + qty);
      }

      // Recent 12-month analysis for forecasting
      if (v.date < twelveMonthsAgoStr) continue;

      const calendarMonth = getMonthIndex(v.date);
      const recentIdx = getRecentMonthIndex(v.date);
      if (recentIdx < 0 || recentIdx > 11) continue;

      if (v.voucherType === "Sales") {
        const monthly = itemMonthlyDemand.get(line.itemId)!;
        monthly[calendarMonth] += qty;
        const recent = itemMonthlySales.get(line.itemId)!;
        recent[recentIdx] += qty;
        itemTotalRevenue.set(line.itemId, (itemTotalRevenue.get(line.itemId) ?? 0) + qty * rate);
      } else if (v.voucherType === "Purchase") {
        const recent = itemMonthlyPurchases.get(line.itemId)!;
        recent[recentIdx] += qty;
      }
    }
  }

  // ABC classification by revenue
  const revenueEntries = Array.from(itemTotalRevenue.entries()).sort((a, b) => b[1] - a[1]);
  const totalRevenue = revenueEntries.reduce((s, [, r]) => s + r, 0);
  const abcMap = new Map<string, "A" | "B" | "C">();
  let cumRevenue = 0;
  for (const [itemId, rev] of revenueEntries) {
    cumRevenue += rev;
    const pct = totalRevenue > 0 ? cumRevenue / totalRevenue : 1;
    if (pct <= 0.8) abcMap.set(itemId, "A");
    else if (pct <= 0.95) abcMap.set(itemId, "B");
    else abcMap.set(itemId, "C");
  }

  const forecasts: ItemForecast[] = [];
  const alerts: InventoryAlert[] = [];

  for (const [itemId, item] of items) {
    const monthlySales = itemMonthlySales.get(itemId) ?? new Array(12).fill(0);
    const monthlyPurchases = itemMonthlyPurchases.get(itemId) ?? new Array(12).fill(0);
    const calendarDemand = itemMonthlyDemand.get(itemId) ?? new Array(12).fill(0);

    // Weighted moving average — exponentially increasing recency bias
    // Oldest months contribute minimally, most recent months dominate
    // This captures recent demand shifts faster for seasonal businesses
    const weights = [1, 1, 1, 2, 2, 2, 3, 3, 4, 5, 6, 8];
    let weightedSum = 0;
    let weightTotal = 0;
    let activeMonths = 0;
    for (let i = 0; i < 12; i++) {
      if (monthlySales[i] > 0) activeMonths++;
      weightedSum += monthlySales[i] * weights[i];
      weightTotal += weights[i];
    }
    const avgMonthlyDemand = weightTotal > 0 ? weightedSum / weightTotal : 0;

    // Average monthly supply
    const totalSupply = monthlyPurchases.reduce((s, v) => s + v, 0);
    const avgMonthlySupply = totalSupply / 12;

    // Demand trend (compare last 3 months vs prior 3 months)
    const recent3 = monthlySales.slice(9, 12).reduce((s, v) => s + v, 0) / 3;
    const prior3 = monthlySales.slice(6, 9).reduce((s, v) => s + v, 0) / 3;
    let demandTrend: "rising" | "falling" | "stable" = "stable";
    if (prior3 > 0) {
      const ratio = recent3 / prior3;
      if (ratio > 1.2) demandTrend = "rising";
      else if (ratio < 0.8) demandTrend = "falling";
    }

    // 12-month seasonal decomposition
    const totalCalendarDemand = calendarDemand.reduce((s, v) => s + v, 0);
    const avgCalendarDemand = totalCalendarDemand / 12;
    const seasonalFactors = calendarDemand.map(d =>
      avgCalendarDemand > 0 ? Math.round((d / avgCalendarDemand) * 100) / 100 : 1
    );

    // Forecasts
    const nextMonthIdx = (currentMonth + 1) % 12;
    const nextMonthFactor = seasonalFactors[nextMonthIdx] || 1;
    const nextMonthForecast = Math.round(avgMonthlyDemand * Math.max(0.5, Math.min(2, nextMonthFactor)));

    let next3MonthForecast = 0;
    for (let i = 1; i <= 3; i++) {
      const mIdx = (currentMonth + i) % 12;
      const factor = seasonalFactors[mIdx] || 1;
      next3MonthForecast += avgMonthlyDemand * Math.max(0.5, Math.min(2, factor));
    }
    next3MonthForecast = Math.round(next3MonthForecast);

    // Current stock: opening + all purchases + credit notes + stock journals - all sales - debit notes
    const opening = item.openingQtyBase ?? 0;
    const currentStock = Math.round(
      opening
      + (itemAllTimePurchases.get(itemId) ?? 0)
      - (itemAllTimeSales.get(itemId) ?? 0)
      + (itemAllTimeCreditNotes.get(itemId) ?? 0)  // sales returns come back
      - (itemAllTimeDebitNotes.get(itemId) ?? 0)    // purchase returns go out
      + (itemAllTimeStockJournals.get(itemId) ?? 0) // stock journal net effect
    );

    // Days of stock remaining
    const dailyDemand = avgMonthlyDemand / 30;
    const daysOfStockRemaining = dailyDemand > 0 ? Math.round(currentStock / dailyDemand) : currentStock > 0 ? 999 : 0;

    // Safety stock (1.5x lead time demand)
    const safetyStock = Math.round(dailyDemand * DEFAULT_LEAD_TIME * 1.5);

    // Reorder point (lead time demand + safety stock)
    const reorderPoint = Math.round(dailyDemand * DEFAULT_LEAD_TIME + safetyStock);

    // Suggested purchase qty (cover next 2 months + safety, minus current stock)
    const coverDemand = nextMonthForecast * 2 + safetyStock;
    const suggestedPurchaseQty = Math.max(0, roundToPackage(coverDemand - currentStock, item.unitsPerPkg));

    // Velocity classification
    let velocityClass: "fast" | "medium" | "slow" | "dead" = "medium";
    if (activeMonths === 0) velocityClass = "dead";
    else if (recent3 === 0 && prior3 === 0) velocityClass = "dead";
    else if (recent3 === 0) velocityClass = "slow";
    else if (prior3 > 0 && recent3 / prior3 > 1.5) velocityClass = "fast";
    else if (prior3 > 0 && recent3 / prior3 < 0.5) velocityClass = "slow";

    // ABC class
    const abcClass = abcMap.get(itemId) ?? "C";

    // Stock health status
    let stockHealthStatus: "critical" | "low" | "adequate" | "excess" | "dead" = "adequate";
    if (velocityClass === "dead") {
      stockHealthStatus = currentStock > 0 ? "dead" : "dead";
    } else if (daysOfStockRemaining <= 0) {
      stockHealthStatus = "critical";
    } else if (daysOfStockRemaining < DEFAULT_LEAD_TIME + 7) {
      stockHealthStatus = "low";
    } else if (avgMonthlyDemand > 0 && currentStock > avgMonthlyDemand * 6) {
      stockHealthStatus = "excess";
    }

    forecasts.push({
      itemId,
      itemName: item.name,
      group: item.group,
      currentStock,
      avgMonthlyDemand: Math.round(avgMonthlyDemand * 100) / 100,
      avgMonthlySupply: Math.round(avgMonthlySupply * 100) / 100,
      demandTrend,
      seasonalFactors,
      nextMonthForecast,
      next3MonthForecast,
      daysOfStockRemaining,
      reorderPoint,
      safetyStock,
      suggestedPurchaseQty,
      velocityClass,
      abcClass,
      stockHealthStatus,
      leadTimeDays: DEFAULT_LEAD_TIME,
    });

    // Generate alerts
    if (stockHealthStatus === "critical" && avgMonthlyDemand > 0) {
      alerts.push({
        itemId,
        itemName: item.name,
        alertType: "stockout_imminent",
        severity: "critical",
        message: `${item.name} has ${currentStock} units remaining (${daysOfStockRemaining} days). Stockout imminent!`,
        currentStock,
        suggestedAction: `Purchase ${suggestedPurchaseQty} ${item.baseUnit} immediately`,
        metric: daysOfStockRemaining,
      });
    } else if (stockHealthStatus === "low") {
      alerts.push({
        itemId,
        itemName: item.name,
        alertType: "reorder_now",
        severity: "warning",
        message: `${item.name} is below reorder point (${currentStock} units, ${daysOfStockRemaining} days of stock)`,
        currentStock,
        suggestedAction: `Purchase ${suggestedPurchaseQty} ${item.baseUnit}`,
        metric: daysOfStockRemaining,
      });
    }

    if (stockHealthStatus === "excess" && currentStock > 0) {
      alerts.push({
        itemId,
        itemName: item.name,
        alertType: "excess_stock",
        severity: "info",
        message: `${item.name} has ${daysOfStockRemaining} days of stock (${currentStock} units). Consider reducing purchases.`,
        currentStock,
        suggestedAction: "Reduce purchase orders or run promotions",
        metric: daysOfStockRemaining,
      });
    }

    if (velocityClass === "dead" && currentStock > 0) {
      alerts.push({
        itemId,
        itemName: item.name,
        alertType: "dead_stock",
        severity: "warning",
        message: `${item.name} has no demand in the last 3 months but ${currentStock} units in stock`,
        currentStock,
        suggestedAction: "Consider clearance sale or return to supplier",
        metric: currentStock,
      });
    }

    if (demandTrend === "rising" && prior3 > 0 && recent3 / prior3 > 2) {
      alerts.push({
        itemId,
        itemName: item.name,
        alertType: "demand_spike",
        severity: "info",
        message: `${item.name} demand spiked ${Math.round((recent3 / prior3) * 100)}% vs prior period`,
        currentStock,
        suggestedAction: "Increase purchase quantities to match rising demand",
        metric: Math.round((recent3 / prior3) * 100),
      });
    }

    if (demandTrend === "falling" && prior3 > 0 && recent3 / prior3 < 0.4) {
      alerts.push({
        itemId,
        itemName: item.name,
        alertType: "demand_drop",
        severity: "info",
        message: `${item.name} demand dropped ${Math.round((1 - recent3 / prior3) * 100)}% vs prior period`,
        currentStock,
        suggestedAction: "Review purchasing — demand may be seasonal or declining",
        metric: Math.round((1 - recent3 / prior3) * 100),
      });
    }
  }

  // Sort alerts by severity
  const severityOrder = { critical: 0, warning: 1, info: 2 };
  alerts.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  return { forecasts, alerts };
}

// ─────────────────────────────────────────────────────────────────────
// Prediction Accuracy Scoring (unchanged interface)
// ─────────────────────────────────────────────────────────────────────

export function scorePredictions(
  previousPredictions: PartyOrderPattern[],
  newVouchers: CanonicalVoucher[],
  voucherType: "Sales" | "Purchase" = "Sales"
): PredictionAccuracy[] {
  const results: PredictionAccuracy[] = [];

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
      const sorted = [...actuals].sort((a, b) => a.date.localeCompare(b.date));
      const firstNew = sorted.find(v => v.date > pred.lastOrderDate);

      if (firstNew) {
        actualDate = firstNew.date;
        dateDiff = daysBetween(pred.predictedNextDate, actualDate);
        dateScore = Math.max(0, 1 - Math.abs(dateDiff) / (pred.avgIntervalDays || 30));
      }

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
