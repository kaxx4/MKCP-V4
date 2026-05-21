/**
 * Party RFM / churn / prediction stats — extracted from `pages/Outreach.tsx`
 * so it can be pre-computed once at data-load time in `dataStore.ts` and
 * read by Outreach (and any future consumer) without recomputing.
 *
 * This file is a utility, not a compute engine. Pure functions, no side effects.
 */

import type { CanonicalVoucher, CanonicalLedger } from "../types/canonical";

export interface PartyStats {
  ledgerId: string;
  name: string;
  totalRevenue: number;
  orderCount: number;
  avgOrderValue: number;
  lastOrderDate: string;
  daysSinceLast: number;
  ordersPerMonth: number;
  trend: "growing" | "stable" | "declining";
  trendPct: number;
  churnRisk: number;
  rfmR: number;
  rfmF: number;
  rfmM: number;
  tier: "anchor" | "secondary" | "longtail";
  predictedNextOrder: string | null;
  predictedConfidence: number;
  predictedValue: number;
  avgInterval: number;
  monthlyRevenue: { label: string; amount: number }[];
  topItems: { itemId: string; name: string; revenue: number }[];
}

export function computePartyStats(
  vouchers: CanonicalVoucher[],
  ledgers: Map<string, CanonicalLedger>
): PartyStats[] {
  const now = new Date();

  // Only completed sales vouchers
  const sales = vouchers.filter(
    (v) =>
      v.voucherType === "Sales" &&
      !v.isCancelled &&
      !v.isOptional &&
      v.partyLedgerId
  );

  // Group by party
  const byParty = new Map<string, CanonicalVoucher[]>();
  for (const v of sales) {
    const pid = v.partyLedgerId!;
    if (!byParty.has(pid)) byParty.set(pid, []);
    byParty.get(pid)!.push(v);
  }

  const results: PartyStats[] = [];

  for (const [ledgerId, pvouchers] of byParty) {
    if (pvouchers.length === 0) continue;
    const sorted = [...pvouchers].sort((a, b) => a.date.localeCompare(b.date));
    const ledger = ledgers.get(ledgerId);
    const name = ledger?.name ?? ledgerId;

    // ── Revenue & basic stats ─────────────────────────────────────
    const totalRevenue = sorted.reduce((s, v) => s + v.totalAmount, 0);
    const orderCount = sorted.length;
    const avgOrderValue = orderCount > 0 ? totalRevenue / orderCount : 0;
    const lastOrderDate = sorted[sorted.length - 1].date;
    const lastDate = new Date(lastOrderDate);
    const daysSinceLast = Math.max(
      0,
      Math.floor((now.getTime() - lastDate.getTime()) / 864e5)
    );

    // ── Frequency ─────────────────────────────────────────────────
    const firstDate = new Date(sorted[0].date);
    const monthsActive = Math.max(
      1,
      (now.getTime() - firstDate.getTime()) / (864e5 * 30)
    );
    const ordersPerMonth = orderCount / monthsActive;

    // ── Revenue trend: last 3mo vs prev 3mo ──────────────────────
    const d3ago = new Date(now);
    d3ago.setMonth(d3ago.getMonth() - 3);
    const d6ago = new Date(now);
    d6ago.setMonth(d6ago.getMonth() - 6);
    const d3str = d3ago.toISOString().slice(0, 10);
    const d6str = d6ago.toISOString().slice(0, 10);

    const recentRev = sorted
      .filter((v) => v.date >= d3str)
      .reduce((s, v) => s + v.totalAmount, 0);
    const prevRev = sorted
      .filter((v) => v.date >= d6str && v.date < d3str)
      .reduce((s, v) => s + v.totalAmount, 0);

    let trend: PartyStats["trend"] = "stable";
    let trendPct = 0;
    if (prevRev > 0) {
      trendPct = ((recentRev - prevRev) / prevRev) * 100;
      if (trendPct > 10) trend = "growing";
      else if (trendPct < -10) trend = "declining";
    } else if (recentRev > 0) {
      trend = "growing";
      trendPct = 100;
    }

    // ── RFM Scoring ───────────────────────────────────────────────
    const rfmR =
      daysSinceLast < 10 ? 100 :
      daysSinceLast < 20 ? 80 :
      daysSinceLast < 30 ? 60 :
      daysSinceLast < 60 ? 40 :
      daysSinceLast < 90 ? 20 : 0;
    const rfmF = Math.min(100, (ordersPerMonth / 2) * 100);
    const rfmM = Math.min(100, (avgOrderValue / 200000) * 100); // ₹2L = 100
    const rfmScore = rfmR * 0.4 + rfmF * 0.3 + rfmM * 0.3;
    const churnRisk = Math.round(Math.max(0, 100 - rfmScore));

    // ── Tier classification ───────────────────────────────────────
    let tier: PartyStats["tier"] = "longtail";
    if (totalRevenue >= 5_00_00_000) tier = "anchor";      // ≥₹5Cr
    else if (totalRevenue >= 20_00_000) tier = "secondary"; // ≥₹20L

    // ── Purchase interval prediction ──────────────────────────────
    let predictedNextOrder: string | null = null;
    let predictedConfidence = 0;
    let predictedValue = 0;
    let avgInterval = 0;

    if (sorted.length >= 2) {
      const intervals: number[] = [];
      for (let i = 1; i < sorted.length; i++) {
        const prev = new Date(sorted[i - 1].date);
        const curr = new Date(sorted[i].date);
        intervals.push((curr.getTime() - prev.getTime()) / 864e5);
      }
      avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      const variance =
        intervals.reduce((s, x) => s + (x - avgInterval) ** 2, 0) /
        intervals.length;
      const stdDev = Math.sqrt(variance);
      const cv = avgInterval > 0 ? stdDev / avgInterval : 1;

      const predictedDate = new Date(lastDate);
      predictedDate.setDate(predictedDate.getDate() + Math.round(avgInterval));
      predictedNextOrder = predictedDate.toISOString().slice(0, 10);

      const consistency = Math.max(0, 1 - Math.min(cv, 1));
      const recencyFactor =
        daysSinceLast < 30 ? 1.0 :
        daysSinceLast < 60 ? 0.8 : 0.6;
      const countFactor = Math.min(1.0, sorted.length / 12);
      predictedConfidence = Math.round(
        consistency * recencyFactor * countFactor * 100
      );
      predictedValue = avgOrderValue;
    }

    // ── Monthly revenue chart — last 6 months ─────────────────────
    const monthlyRevenue: PartyStats["monthlyRevenue"] = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now);
      d.setMonth(d.getMonth() - i);
      const ym = d.toISOString().slice(0, 7);
      const label = d.toLocaleDateString("en-IN", {
        month: "short",
        year: "2-digit",
      });
      const amount = sorted
        .filter((v) => v.date.startsWith(ym))
        .reduce((s, v) => s + v.totalAmount, 0);
      monthlyRevenue.push({ label, amount });
    }

    // ── Top items by line revenue ──────────────────────────────────
    const itemRevMap = new Map<string, { revenue: number }>();
    for (const v of sorted) {
      for (const line of v.lines) {
        if (
          line.type === "inventory" &&
          line.itemId &&
          line.lineAmount != null
        ) {
          const existing = itemRevMap.get(line.itemId);
          if (existing) {
            existing.revenue += line.lineAmount;
          } else {
            itemRevMap.set(line.itemId, { revenue: line.lineAmount });
          }
        }
      }
    }
    const topItems = Array.from(itemRevMap.entries())
      .map(([itemId, d]) => ({ itemId, name: itemId, revenue: d.revenue }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5);

    results.push({
      ledgerId,
      name,
      totalRevenue,
      orderCount,
      avgOrderValue,
      lastOrderDate,
      daysSinceLast,
      ordersPerMonth,
      trend,
      trendPct,
      churnRisk,
      rfmR,
      rfmF,
      rfmM,
      tier,
      predictedNextOrder,
      predictedConfidence,
      predictedValue,
      avgInterval,
      monthlyRevenue,
      topItems,
    });
  }

  return results.sort((a, b) => b.totalRevenue - a.totalRevenue);
}
