import { useState, useMemo, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
} from "recharts";
import {
  Upload,
  Phone,
  TrendingUp,
  TrendingDown,
  Users,
  Calendar,
  AlertTriangle,
  ChevronRight,
  ArrowUpRight,
  ArrowDownRight,
  X,
  CheckCircle,
  Zap,
  Target,
  BarChart2,
  Clock,
} from "lucide-react";
import { useDataStore } from "../store/dataStore";
import { useUIStore } from "../store/uiStore";
import { fmtINR, fmtNum } from "../utils/format";
import clsx from "clsx";
import type { CanonicalVoucher, CanonicalLedger } from "../types/canonical";

// ═══════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════

interface PartyStats {
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

interface OutreachOpp {
  id: string;
  type: "upsell" | "reactivation" | "retention";
  party: PartyStats;
  priorityScore: number;
  estimatedValue: number;
  conversionProbability: number;
  daysToAct: number;
  rationale: string;
  action: string;
  offer: string;
}

// ═══════════════════════════════════════════════════════════════════
// ANALYTICS ENGINE  (pure functions — no side effects)
// ═══════════════════════════════════════════════════════════════════

function computePartyStats(
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

function generateOpportunities(parties: PartyStats[]): OutreachOpp[] {
  const opps: OutreachOpp[] = [];

  for (const party of parties) {
    // ── UPSELL: predicted order in next 14 days, ≥50% confidence ──
    if (party.predictedNextOrder && party.predictedConfidence >= 50) {
      const daysToOrder = Math.round(
        (new Date(party.predictedNextOrder).getTime() - Date.now()) / 864e5
      );
      if (daysToOrder >= -2 && daysToOrder <= 14) {
        const daysToAct = Math.max(0, daysToOrder - 3);
        opps.push({
          id: `UPSELL-${party.ledgerId}`,
          type: "upsell",
          party,
          priorityScore:
            party.predictedConfidence * (party.totalRevenue / 1_00_00_000),
          estimatedValue: party.predictedValue,
          conversionProbability: party.predictedConfidence / 100,
          daysToAct,
          rationale: `Order predicted ${
            daysToOrder <= 0
              ? "now — window is open!"
              : `in ${daysToOrder} day${daysToOrder !== 1 ? "s" : ""}`
          } based on ${party.orderCount} historical orders (avg ${Math.round(party.avgInterval)}d interval)`,
          action:
            daysToAct === 0
              ? "Call TODAY — order window open"
              : `Schedule call for ${new Date(
                  Date.now() + daysToAct * 864e5
                ).toLocaleDateString("en-IN", {
                  day: "numeric",
                  month: "short",
                })}`,
          offer: "2% early-order discount if confirmed within 48 hours",
        });
      }
    }

    // ── REACTIVATION: high churn + overdue for non-longtail ────────
    if (party.churnRisk > 60 && party.tier !== "longtail") {
      const expectedInterval = Math.max(
        7,
        30 / Math.max(0.5, party.ordersPerMonth)
      );
      if (party.daysSinceLast > expectedInterval * 1.5) {
        opps.push({
          id: `REACTIV-${party.ledgerId}`,
          type: "reactivation",
          party,
          priorityScore:
            party.churnRisk * (party.totalRevenue / 1_00_00_000) * 0.8,
          estimatedValue: party.avgOrderValue,
          conversionProbability: 0.55,
          daysToAct: 0,
          rationale: `${party.daysSinceLast} days since last order (expected every ~${Math.round(expectedInterval)} days). Churn risk: ${party.churnRisk}/100`,
          action:
            "Immediate personal call to check status & investigate gap",
          offer: "3-5% loyalty discount on next order to re-engage",
        });
      }
    }

    // ── RETENTION: declining revenue for anchor/secondary ──────────
    if (
      party.trend === "declining" &&
      party.trendPct < -15 &&
      party.tier !== "longtail"
    ) {
      opps.push({
        id: `RETAIN-${party.ledgerId}`,
        type: "retention",
        party,
        priorityScore:
          Math.abs(party.trendPct) * (party.totalRevenue / 1_00_00_000) * 0.6,
        estimatedValue: party.totalRevenue * 0.1,
        conversionProbability: 0.65,
        daysToAct: 3,
        rationale: `Revenue down ${Math.abs(Math.round(party.trendPct))}% vs previous quarter. Strategic account at risk.`,
        action:
          "Schedule Executive Business Review with owner/manager within 7 days",
        offer:
          "Volume commitment: 3-5% discount for monthly purchase guarantee",
      });
    }
  }

  // De-duplicate: if REACTIV and RETAIN both exist for same party, keep higher priority
  const seen = new Set<string>();
  const deduped: OutreachOpp[] = [];
  for (const opp of opps.sort((a, b) => b.priorityScore - a.priorityScore)) {
    const key = `${opp.party.ledgerId}-${opp.type}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(opp);
    }
  }

  return deduped;
}

// ═══════════════════════════════════════════════════════════════════
// STATIC CONFIG
// ═══════════════════════════════════════════════════════════════════

const OPP_CONFIG = {
  upsell: {
    label: "Upsell",
    color: "text-accent",
    bg: "bg-accent/10",
    icon: TrendingUp,
  },
  reactivation: {
    label: "Reactivation",
    color: "text-warn",
    bg: "bg-warn/10",
    icon: Zap,
  },
  retention: {
    label: "Retention",
    color: "text-danger",
    bg: "bg-danger/10",
    icon: AlertTriangle,
  },
} as const;

const TIER_CONFIG = {
  anchor: {
    label: "Anchor",
    color: "text-accent",
    bg: "bg-accent/10",
  },
  secondary: {
    label: "Secondary",
    color: "text-warn",
    bg: "bg-warn/10",
  },
  longtail: {
    label: "Long-tail",
    color: "text-neutral-500",
    bg: "bg-neutral-100",
  },
} as const;

// ═══════════════════════════════════════════════════════════════════
// PARTY DETAIL PANEL
// ═══════════════════════════════════════════════════════════════════

function PartyPanel({
  party,
  onClose,
}: {
  party: PartyStats;
  onClose: () => void;
}) {
  const tierConf = TIER_CONFIG[party.tier];

  const rfmData = [
    { name: "Recency", value: Math.round(party.rfmR) },
    { name: "Frequency", value: Math.round(party.rfmF) },
    { name: "Monetary", value: Math.round(party.rfmM) },
  ];

  const churnColor =
    party.churnRisk > 65
      ? "text-danger"
      : party.churnRisk > 40
      ? "text-warn"
      : "text-success";

  const lastOrderColor =
    party.daysSinceLast > 45
      ? "text-danger"
      : party.daysSinceLast > 21
      ? "text-warn"
      : "text-success";

  return (
    <div className="flex flex-col gap-3 overflow-y-auto" style={{ maxHeight: "76vh" }}>
      {/* ── Header ────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5 mb-1">
            <span
              className={clsx(
                "text-[10px] font-semibold px-2 py-0.5 rounded-full",
                tierConf.bg,
                tierConf.color
              )}
            >
              {tierConf.label}
            </span>
            {party.trend === "growing" && (
              <span className="badge badge-success text-[10px]">↑ Growing</span>
            )}
            {party.trend === "declining" && (
              <span className="badge badge-danger text-[10px]">↓ Declining</span>
            )}
          </div>
          <h3
            className="font-bold text-sm text-primary leading-tight"
            title={party.name}
          >
            {party.name}
          </h3>
          <p className="text-xs text-muted mt-0.5">
            {party.orderCount} orders · {fmtINR(party.avgOrderValue)} avg
          </p>
        </div>
        <button onClick={onClose} className="btn-icon flex-shrink-0 -mt-0.5">
          <X size={15} />
        </button>
      </div>

      {/* ── KPI Grid ──────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-2">
        {[
          {
            label: "Annual Revenue",
            value: fmtINR(party.totalRevenue),
            color: "text-primary",
          },
          {
            label: "Churn Risk",
            value: `${party.churnRisk}/100`,
            color: churnColor,
          },
          {
            label: "Orders / Month",
            value: party.ordersPerMonth.toFixed(1),
            color: "text-primary",
          },
          {
            label: "Last Order",
            value: `${party.daysSinceLast}d ago`,
            color: lastOrderColor,
          },
        ].map(({ label, value, color }) => (
          <div key={label} className="bento-card py-2 px-3">
            <div className="text-[10px] text-muted">{label}</div>
            <div className={clsx("text-sm font-bold tabular-nums mt-0.5", color)}>
              {value}
            </div>
          </div>
        ))}
      </div>

      {/* ── Revenue Trend Chart ───────────────────────────────── */}
      <div className="bento-card">
        <div className="text-xs font-medium text-muted mb-2">
          6-Month Revenue Trend
        </div>
        <ResponsiveContainer width="100%" height={80}>
          <AreaChart
            data={party.monthlyRevenue}
            margin={{ top: 2, right: 2, left: 2, bottom: 0 }}
          >
            <defs>
              <linearGradient id="partyGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#6366f1" stopOpacity={0.25} />
                <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis
              dataKey="label"
              tick={{ fontSize: 9 }}
              tickLine={false}
              axisLine={false}
            />
            <Tooltip
              formatter={(v: number) => [fmtINR(v), "Revenue"]}
              contentStyle={{ fontSize: 11 }}
              labelStyle={{ fontSize: 10 }}
            />
            <Area
              type="monotone"
              dataKey="amount"
              stroke="#6366f1"
              fill="url(#partyGrad)"
              strokeWidth={1.5}
              dot={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* ── RFM Profile ───────────────────────────────────────── */}
      <div className="bento-card">
        <div className="text-xs font-medium text-muted mb-2">RFM Profile</div>
        <ResponsiveContainer width="100%" height={60}>
          <BarChart
            data={rfmData}
            margin={{ top: 0, right: 4, left: 4, bottom: 0 }}
          >
            <XAxis
              dataKey="name"
              tick={{ fontSize: 9 }}
              tickLine={false}
              axisLine={false}
            />
            <Tooltip
              formatter={(v: number) => [`${v}/100`, ""]}
              contentStyle={{ fontSize: 10 }}
            />
            <Bar
              dataKey="value"
              fill="#6366f1"
              radius={[3, 3, 0, 0]}
              maxBarSize={32}
            />
          </BarChart>
        </ResponsiveContainer>
        <div className="grid grid-cols-3 gap-1 mt-1">
          {rfmData.map(({ name, value }) => (
            <div key={name} className="text-center">
              <div className="text-xs font-bold tabular-nums text-primary">
                {value}
              </div>
              <div className="text-[9px] text-muted">{name}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Predicted Next Order ──────────────────────────────── */}
      {party.predictedNextOrder && party.predictedConfidence > 0 && (
        <div
          className={clsx(
            "bento-card border",
            party.predictedConfidence >= 70
              ? "border-accent/30 bg-accent/3"
              : "border-warn/30 bg-warn/3"
          )}
        >
          <div className="flex items-center gap-1.5 mb-1">
            <Calendar size={12} className="text-muted" />
            <span className="text-xs font-medium text-muted">
              Predicted Next Order
            </span>
          </div>
          <div className="text-sm font-bold text-primary">
            {new Date(party.predictedNextOrder).toLocaleDateString("en-IN", {
              day: "numeric",
              month: "short",
              year: "numeric",
            })}
          </div>
          <div className="text-xs text-muted mt-0.5">
            {party.predictedConfidence}% confidence ·{" "}
            {fmtINR(party.predictedValue)} est. value
          </div>
        </div>
      )}

      {/* ── Top Items ─────────────────────────────────────────── */}
      {party.topItems.length > 0 && (
        <div className="bento-card">
          <div className="text-xs font-medium text-muted mb-2">
            Top Items Purchased
          </div>
          <div className="space-y-1.5">
            {party.topItems.map((item) => (
              <div
                key={item.itemId}
                className="flex items-center justify-between gap-2"
              >
                <div
                  className="text-xs text-primary truncate min-w-0 flex-1"
                  title={item.name}
                >
                  {item.name.length > 28
                    ? item.name.slice(0, 25) + "…"
                    : item.name}
                </div>
                <div className="text-xs tabular-nums text-muted flex-shrink-0">
                  {fmtINR(item.revenue)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// OPPORTUNITY CARD
// ═══════════════════════════════════════════════════════════════════

function OppCard({
  opp,
  isSelected,
  onSelect,
}: {
  opp: OutreachOpp;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const cfg = OPP_CONFIG[opp.type];
  const Icon = cfg.icon;

  return (
    <button
      onClick={onSelect}
      className={clsx(
        "w-full text-left bento-card flex items-start gap-3 transition-[box-shadow,border-color] duration-150 cursor-pointer",
        isSelected
          ? "ring-1 ring-accent border-accent/30"
          : "hover:border-neutral-300"
      )}
    >
      {/* Type icon bubble */}
      <div
        className={clsx(
          "flex-shrink-0 rounded-lg p-1.5 mt-0.5",
          cfg.bg
        )}
      >
        <Icon size={13} className={cfg.color} />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 mb-0.5 flex-wrap">
          <span
            className={clsx(
              "text-[10px] font-semibold px-1.5 py-0.5 rounded",
              cfg.bg,
              cfg.color
            )}
          >
            {cfg.label}
          </span>
          <span className="text-xs font-semibold text-primary truncate">
            {opp.party.name}
          </span>
        </div>
        <p className="text-xs text-muted line-clamp-1 mb-0.5">{opp.rationale}</p>
        <p className="text-[11px] font-medium text-accent line-clamp-1">
          → {opp.action}
        </p>
      </div>

      {/* Right metrics */}
      <div className="flex-shrink-0 text-right space-y-0.5">
        <div className="text-sm font-bold text-primary tabular-nums">
          {fmtINR(opp.estimatedValue)}
        </div>
        <div className="text-xs text-muted tabular-nums">
          {Math.round(opp.conversionProbability * 100)}%
        </div>
        {opp.daysToAct === 0 ? (
          <span className="text-[10px] font-bold text-danger">URGENT</span>
        ) : (
          <span className="text-[10px] text-muted">Act in {opp.daysToAct}d</span>
        )}
      </div>
    </button>
  );
}

// ═══════════════════════════════════════════════════════════════════
// CHURN ROW
// ═══════════════════════════════════════════════════════════════════

function ChurnRow({
  party,
  onSelect,
}: {
  party: PartyStats;
  onSelect: () => void;
}) {
  const risk = party.churnRisk;
  const riskColor =
    risk > 70 ? "text-danger" : risk > 50 ? "text-warn" : "text-success";
  const barColor =
    risk > 70 ? "bg-danger" : risk > 50 ? "bg-warn" : "bg-success";

  return (
    <button
      onClick={onSelect}
      className="w-full flex items-center gap-3 px-4 py-2.5 border-b border-neutral-100 last:border-0 hover:bg-neutral-50 transition-colors text-left cursor-pointer"
    >
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-primary truncate">
          {party.name}
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <span
            className={clsx(
              "text-[10px] px-1.5 py-0.5 rounded-full",
              TIER_CONFIG[party.tier].bg,
              TIER_CONFIG[party.tier].color
            )}
          >
            {TIER_CONFIG[party.tier].label}
          </span>
          {party.trend === "declining" && (
            <span className="flex items-center gap-0.5 text-[10px] text-danger">
              <TrendingDown size={9} />
              {Math.abs(Math.round(party.trendPct))}%
            </span>
          )}
          <span className="text-[10px] text-muted">
            {party.daysSinceLast}d since last order
          </span>
        </div>
      </div>

      {/* Risk bar (desktop) */}
      <div className="w-20 hidden md:block">
        <div className="w-full bg-neutral-100 rounded-full h-1.5 mb-1">
          <div
            className={clsx("h-1.5 rounded-full", barColor)}
            style={{ width: `${risk}%` }}
          />
        </div>
      </div>

      {/* Score */}
      <div className="w-14 text-right flex-shrink-0">
        <span className={clsx("text-sm font-bold tabular-nums", riskColor)}>
          {risk}
        </span>
        <span className="text-[10px] text-muted">/100</span>
      </div>

      {/* Revenue (desktop) */}
      <div className="w-24 text-right hidden md:block flex-shrink-0">
        <div className="text-xs tabular-nums font-medium text-primary">
          {fmtINR(party.totalRevenue)}
        </div>
      </div>

      <ChevronRight size={13} className="text-muted flex-shrink-0" />
    </button>
  );
}

// ═══════════════════════════════════════════════════════════════════
// CALENDAR ITEM
// ═══════════════════════════════════════════════════════════════════

function CalendarItem({
  party,
  onSelect,
}: {
  party: PartyStats;
  onSelect: () => void;
}) {
  if (!party.predictedNextOrder) return null;
  const date = new Date(party.predictedNextOrder);
  const daysAway = Math.round((date.getTime() - Date.now()) / 864e5);
  const isOverdue = daysAway < 0;

  const dateBg = isOverdue
    ? "bg-danger/10"
    : daysAway <= 3
    ? "bg-warn/10"
    : "bg-accent/8";
  const dateColor = isOverdue
    ? "text-danger"
    : daysAway <= 3
    ? "text-warn"
    : "text-accent";

  const relativeLabel = isOverdue
    ? `${Math.abs(daysAway)}d overdue`
    : daysAway === 0
    ? "Today"
    : daysAway === 1
    ? "Tomorrow"
    : `In ${daysAway} days`;

  return (
    <button
      onClick={onSelect}
      className="w-full flex items-center gap-3 px-4 py-2.5 border-b border-neutral-100 last:border-0 hover:bg-neutral-50 transition-colors text-left cursor-pointer"
    >
      {/* Date block */}
      <div
        className={clsx(
          "flex-shrink-0 w-11 text-center rounded-lg py-1.5",
          dateBg
        )}
      >
        <div className={clsx("text-base font-bold leading-none", dateColor)}>
          {date.getDate()}
        </div>
        <div className="text-[9px] text-muted leading-none mt-0.5">
          {date.toLocaleDateString("en-IN", { month: "short" })}
        </div>
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-primary truncate">
          {party.name}
        </div>
        <div
          className={clsx(
            "text-xs mt-0.5",
            isOverdue ? "text-danger font-medium" : "text-muted"
          )}
        >
          {relativeLabel}
        </div>
      </div>

      {/* Confidence + value */}
      <div className="text-right flex-shrink-0">
        <div className="text-sm font-semibold text-primary tabular-nums">
          {fmtINR(party.predictedValue)}
        </div>
        <div className="text-xs text-muted">{party.predictedConfidence}% conf.</div>
      </div>
    </button>
  );
}

// ═══════════════════════════════════════════════════════════════════
// MAIN PAGE COMPONENT
// ═══════════════════════════════════════════════════════════════════

type TabId = "opportunities" | "parties" | "churn" | "calendar";

export default function Outreach() {
  const navigate = useNavigate();
  const data = useDataStore((s) => s.data);
  const { isMobile } = useUIStore();

  const [activeTab, setActiveTab] = useState<TabId>("opportunities");
  const [selectedPartyId, setSelectedPartyId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<"ALL" | OutreachOpp["type"]>(
    "ALL"
  );

  // ── Analytics (all from Tally data) ───────────────────────────────
  const { parties, opportunities } = useMemo(() => {
    if (!data) return { parties: [], opportunities: [] };

    const parties = computePartyStats(data.vouchers, data.ledgers);

    // Enrich item names from items map
    for (const party of parties) {
      for (const item of party.topItems) {
        const canonical = data.items.get(item.itemId);
        if (canonical) item.name = canonical.name;
      }
    }

    const opportunities = generateOpportunities(parties);
    return { parties, opportunities };
  }, [data]);

  // ── Filtered views ────────────────────────────────────────────────
  const filteredOpps = useMemo(() => {
    let result = opportunities;
    if (typeFilter !== "ALL") result = result.filter((o) => o.type === typeFilter);
    if (search) {
      const s = search.toLowerCase();
      result = result.filter(
        (o) =>
          o.party.name.toLowerCase().includes(s) ||
          o.rationale.toLowerCase().includes(s)
      );
    }
    return result;
  }, [opportunities, typeFilter, search]);

  const filteredParties = useMemo(() => {
    if (!search) return parties;
    const s = search.toLowerCase();
    return parties.filter((p) => p.name.toLowerCase().includes(s));
  }, [parties, search]);

  const churnParties = useMemo(
    () =>
      [...parties]
        .filter((p) => p.churnRisk > 40)
        .sort((a, b) => b.churnRisk - a.churnRisk),
    [parties]
  );

  const calendarParties = useMemo(
    () =>
      [...parties]
        .filter(
          (p) =>
            p.predictedNextOrder != null &&
            p.predictedConfidence >= 50
        )
        .sort((a, b) =>
          (a.predictedNextOrder ?? "").localeCompare(
            b.predictedNextOrder ?? ""
          )
        ),
    [parties]
  );

  // ── Selected party ─────────────────────────────────────────────
  const selectedParty = useMemo(
    () => parties.find((p) => p.ledgerId === selectedPartyId) ?? null,
    [parties, selectedPartyId]
  );

  // ── KPIs ───────────────────────────────────────────────────────
  const kpis = useMemo(() => {
    const totalEstimated = opportunities.reduce(
      (s, o) => s + o.estimatedValue,
      0
    );
    const avgConf =
      opportunities.length > 0
        ? opportunities.reduce((s, o) => s + o.conversionProbability, 0) /
          opportunities.length
        : 0;
    const urgentCount = opportunities.filter((o) => o.daysToAct === 0).length;
    const atRiskValue = parties
      .filter((p) => p.churnRisk > 65 && p.tier !== "longtail")
      .reduce((s, p) => s + p.totalRevenue, 0);
    return { totalEstimated, avgConf, urgentCount, atRiskValue };
  }, [opportunities, parties]);

  // ── Virtual scroll for parties tab ─────────────────────────────
  const partiesParentRef = useRef<HTMLDivElement>(null);
  const partiesVirtualizer = useVirtualizer({
    count: filteredParties.length,
    getScrollElement: () => partiesParentRef.current,
    estimateSize: () => 60,
    overscan: 12,
  });

  const handleSelectParty = useCallback(
    (ledgerId: string) => {
      setSelectedPartyId((prev) => (prev === ledgerId ? null : ledgerId));
    },
    []
  );

  // ── Empty / no-data states ──────────────────────────────────────
  if (!data) {
    return (
      <div className="empty-state">
        <Phone size={56} className="empty-state-icon" />
        <h2 className="empty-state-title">No Data Loaded</h2>
        <p className="text-sm text-muted mt-1">
          Import Tally data to unlock outreach intelligence.
        </p>
        <button
          onClick={() => navigate("/import")}
          className="btn-primary mt-4"
        >
          <Upload size={15} />
          Import Data
        </button>
      </div>
    );
  }

  if (parties.length === 0) {
    return (
      <div className="empty-state">
        <Users size={56} className="empty-state-icon" />
        <h2 className="empty-state-title">No Sales Data Found</h2>
        <p className="text-sm text-muted mt-1">
          No sales vouchers found in the imported data.
        </p>
      </div>
    );
  }

  const tabs: { id: TabId; label: string; count: number; icon: typeof Target }[] =
    [
      {
        id: "opportunities",
        label: "Opportunities",
        count: opportunities.length,
        icon: Target,
      },
      {
        id: "parties",
        label: "Parties",
        count: parties.length,
        icon: Users,
      },
      {
        id: "churn",
        label: "Churn Risks",
        count: churnParties.length,
        icon: AlertTriangle,
      },
      {
        id: "calendar",
        label: "Predictions",
        count: calendarParties.length,
        icon: Calendar,
      },
    ];

  // ── Render ───────────────────────────────────────────────────────
  return (
    <div className="page-section">
      {/* ── Header ──────────────────────────────────────────────── */}
      <div className="page-header">
        <div className="page-header-row">
          <div>
            <h1 className="page-title">Outreach Intelligence</h1>
            <p className="text-xs text-muted mt-0.5 hidden md:block">
              AI-powered sales opportunities, churn detection &amp; predictive
              analytics
            </p>
          </div>
          {!isMobile && (
            <div className="flex-1 max-w-xs">
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search parties…"
                className="search-input w-full"
              />
            </div>
          )}
        </div>
      </div>

      {/* ── KPI Cards ───────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-3">
        {[
          {
            label: "Potential Revenue",
            value: fmtINR(kpis.totalEstimated),
            sub: `${opportunities.length} opportunities`,
            color: "text-accent",
          },
          {
            label: "At-Risk Revenue",
            value: fmtINR(kpis.atRiskValue),
            sub: `${churnParties.filter((p) => p.churnRisk > 65).length} high-risk parties`,
            color: "text-danger",
          },
          {
            label: "Avg Confidence",
            value: `${Math.round(kpis.avgConf * 100)}%`,
            sub: "prediction model",
            color: "text-success",
          },
          {
            label: "Urgent Actions",
            value: fmtNum(kpis.urgentCount, 0),
            sub: "act today",
            color: kpis.urgentCount > 0 ? "text-warn" : "text-muted",
          },
        ].map(({ label, value, sub, color }) => (
          <div key={label} className="bento-card">
            <div className={clsx("metric-value truncate", color)}>{value}</div>
            <div className="metric-label">{label}</div>
            <div className="text-[10px] text-muted mt-0.5">{sub}</div>
          </div>
        ))}
      </div>

      {/* ── Mobile search ───────────────────────────────────────── */}
      {isMobile && (
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search parties…"
          className="search-input w-full"
        />
      )}

      {/* ── Tabs ─────────────────────────────────────────────────── */}
      <div className="flex gap-0.5 border-b border-neutral-200">
        {tabs.map(({ id, label, count, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={clsx(
              "flex items-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors border-b-2 -mb-px",
              activeTab === id
                ? "border-accent text-accent"
                : "border-transparent text-muted hover:text-primary"
            )}
          >
            <Icon size={13} />
            <span className="hidden sm:inline">{label}</span>
            <span
              className={clsx(
                "px-1.5 py-0.5 rounded-full text-[10px] font-semibold tabular-nums",
                activeTab === id
                  ? "bg-accent/10 text-accent"
                  : "bg-neutral-100 text-muted"
              )}
            >
              {count}
            </span>
          </button>
        ))}
      </div>

      {/* ── Content area (list + optional panel) ──────────────── */}
      <div
        className={clsx(
          "flex gap-4 min-h-0",
          selectedParty && !isMobile ? "flex-row items-start" : "flex-col"
        )}
      >
        {/* ── LEFT: Tab content ─────────────────────────────── */}
        <div
          className={clsx(
            "flex-1 min-w-0",
            selectedParty && !isMobile && "max-w-[58%]"
          )}
        >
          {/* ─── OPPORTUNITIES TAB ──────────────────────── */}
          {activeTab === "opportunities" && (
            <div className="flex flex-col gap-2">
              {/* Type filter chips */}
              <div className="flex flex-wrap gap-1.5">
                {(
                  ["ALL", "upsell", "reactivation", "retention"] as const
                ).map((type) => (
                  <button
                    key={type}
                    onClick={() => setTypeFilter(type)}
                    className={clsx(
                      "filter-chip text-xs",
                      typeFilter === type && "filter-chip-active"
                    )}
                  >
                    {type === "ALL" ? "All Types" : OPP_CONFIG[type].label}
                    {type !== "ALL" && (
                      <span className="ml-1 opacity-60">
                        {opportunities.filter((o) => o.type === type).length}
                      </span>
                    )}
                  </button>
                ))}
              </div>

              {/* List */}
              {filteredOpps.length === 0 ? (
                <div className="empty-state py-16">
                  <CheckCircle size={40} className="empty-state-icon" />
                  <p className="empty-state-title text-base">
                    No opportunities match
                  </p>
                </div>
              ) : (
                <div
                  className="overflow-y-auto flex flex-col gap-2 pr-0.5"
                  style={{ maxHeight: "min(65vh, 600px)" }}
                >
                  {filteredOpps.map((opp) => (
                    <OppCard
                      key={opp.id}
                      opp={opp}
                      isSelected={selectedPartyId === opp.party.ledgerId}
                      onSelect={() => handleSelectParty(opp.party.ledgerId)}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ─── PARTIES TAB ────────────────────────────── */}
          {activeTab === "parties" && (
            <div className="section-card overflow-hidden">
              {/* Table header */}
              <div className="flex table-header-sticky">
                <div className="flex-1 px-4 py-2.5 min-w-0">Party</div>
                <div className="w-28 px-3 py-2.5 text-right hidden md:block">
                  Revenue
                </div>
                <div className="w-16 px-3 py-2.5 text-right hidden lg:block">
                  Orders
                </div>
                <div className="w-20 px-3 py-2.5 text-right">Trend</div>
                <div className="w-20 px-3 py-2.5 text-right">Churn</div>
                <div className="w-10 px-2 py-2.5 text-center" />
              </div>

              {/* Virtual rows */}
              <div
                ref={partiesParentRef}
                className="overflow-y-auto"
                style={{ height: "min(65vh, 500px)" }}
              >
                <div
                  style={{
                    height: `${partiesVirtualizer.getTotalSize()}px`,
                    position: "relative",
                  }}
                >
                  {partiesVirtualizer.getVirtualItems().map((vRow) => {
                    const party = filteredParties[vRow.index];
                    if (!party) return null;
                    const isSelected = selectedPartyId === party.ledgerId;
                    const tc = TIER_CONFIG[party.tier];

                    return (
                      <div
                        key={party.ledgerId}
                        style={{
                          position: "absolute",
                          top: 0,
                          left: 0,
                          width: "100%",
                          transform: `translateY(${vRow.start}px)`,
                          height: `${vRow.size}px`,
                        }}
                        className={clsx(
                          "flex items-center border-b border-neutral-100 transition-colors cursor-pointer",
                          isSelected
                            ? "bg-accent/5"
                            : "hover:bg-neutral-50"
                        )}
                        onClick={() => handleSelectParty(party.ledgerId)}
                      >
                        <div className="flex-1 px-4 min-w-0">
                          <div className="text-sm font-medium text-primary truncate">
                            {party.name}
                          </div>
                          <div className="flex items-center gap-1.5 mt-0.5">
                            <span
                              className={clsx(
                                "text-[10px] px-1.5 py-0.5 rounded-full",
                                tc.bg,
                                tc.color
                              )}
                            >
                              {tc.label}
                            </span>
                            <span className="text-[10px] text-muted">
                              {party.daysSinceLast}d ago
                            </span>
                          </div>
                        </div>
                        <div className="w-28 px-3 text-right text-xs tabular-nums text-primary hidden md:block">
                          {fmtINR(party.totalRevenue)}
                        </div>
                        <div className="w-16 px-3 text-right text-xs tabular-nums text-muted hidden lg:block">
                          {party.orderCount}
                        </div>
                        <div className="w-20 px-3 text-right">
                          {party.trend === "growing" ? (
                            <span className="flex items-center justify-end gap-0.5 text-xs text-success">
                              <ArrowUpRight size={11} />
                              {Math.round(party.trendPct)}%
                            </span>
                          ) : party.trend === "declining" ? (
                            <span className="flex items-center justify-end gap-0.5 text-xs text-danger">
                              <ArrowDownRight size={11} />
                              {Math.abs(Math.round(party.trendPct))}%
                            </span>
                          ) : (
                            <span className="text-xs text-muted">—</span>
                          )}
                        </div>
                        <div
                          className={clsx(
                            "w-20 px-3 text-right text-sm font-semibold tabular-nums",
                            party.churnRisk > 65
                              ? "text-danger"
                              : party.churnRisk > 40
                              ? "text-warn"
                              : "text-success"
                          )}
                        >
                          {party.churnRisk}
                        </div>
                        <div className="w-10 px-2 text-center">
                          <ChevronRight
                            size={13}
                            className={clsx(
                              "transition-transform",
                              isSelected
                                ? "text-accent rotate-90"
                                : "text-muted"
                            )}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* ─── CHURN RISKS TAB ────────────────────────── */}
          {activeTab === "churn" && (
            <div className="section-card overflow-hidden">
              {/* Header row */}
              <div className="flex items-center px-4 py-2 border-b border-neutral-200 bg-neutral-50">
                <div className="flex-1 text-xs font-medium text-muted">
                  Party
                </div>
                <div className="w-20 text-xs text-muted text-center hidden md:block">
                  Risk bar
                </div>
                <div className="w-14 text-xs text-muted text-right">
                  Score
                </div>
                <div className="w-24 text-xs text-muted text-right hidden md:block">
                  Revenue
                </div>
                <div className="w-5" />
              </div>

              <div
                className="overflow-y-auto"
                style={{ maxHeight: "min(65vh, 500px)" }}
              >
                {churnParties.length === 0 ? (
                  <div className="empty-state py-14">
                    <CheckCircle size={36} className="empty-state-icon" />
                    <p className="empty-state-title text-base">
                      No churn risks detected
                    </p>
                  </div>
                ) : (
                  churnParties.map((party) => (
                    <ChurnRow
                      key={party.ledgerId}
                      party={party}
                      onSelect={() => handleSelectParty(party.ledgerId)}
                    />
                  ))
                )}
              </div>
            </div>
          )}

          {/* ─── CALENDAR / PREDICTIONS TAB ────────────── */}
          {activeTab === "calendar" && (
            <div className="section-card overflow-hidden">
              <div className="px-4 py-3 border-b border-neutral-200">
                <div className="flex items-center gap-2">
                  <Clock size={13} className="text-muted" />
                  <span className="text-sm font-semibold text-primary">
                    Predicted Orders — Next 30 Days
                  </span>
                </div>
                <p className="text-xs text-muted mt-0.5">
                  Based on historical purchase intervals · Click row to view
                  party profile
                </p>
              </div>

              <div
                className="overflow-y-auto"
                style={{ maxHeight: "min(65vh, 500px)" }}
              >
                {calendarParties.length === 0 ? (
                  <div className="empty-state py-14">
                    <Calendar size={36} className="empty-state-icon" />
                    <p className="empty-state-title text-base">
                      No predictions yet
                    </p>
                    <p className="text-xs text-muted mt-1">
                      Need ≥2 orders per party to detect patterns.
                    </p>
                  </div>
                ) : (
                  calendarParties.map((party) => (
                    <CalendarItem
                      key={party.ledgerId}
                      party={party}
                      onSelect={() => {
                        handleSelectParty(party.ledgerId);
                        setActiveTab("parties");
                      }}
                    />
                  ))
                )}
              </div>
            </div>
          )}
        </div>

        {/* ── RIGHT: Party detail panel (desktop only) ─── */}
        {selectedParty && !isMobile && (
          <div className="w-[280px] flex-shrink-0">
            <div className="section-card p-4">
              <PartyPanel
                party={selectedParty}
                onClose={() => setSelectedPartyId(null)}
              />
            </div>
          </div>
        )}
      </div>

      {/* ── Mobile: Party detail bottom sheet ──────────────────── */}
      {selectedParty && isMobile && (
        <div className="fixed inset-0 z-50 flex items-end">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => setSelectedPartyId(null)}
          />
          {/* Sheet */}
          <div className="relative w-full bg-white rounded-t-2xl px-4 pt-4 pb-8 shadow-2xl animate-slide-up">
            <div className="w-8 h-1 bg-neutral-300 rounded-full mx-auto mb-4" />
            <PartyPanel
              party={selectedParty}
              onClose={() => setSelectedPartyId(null)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
