import type { CanonicalVoucher, CanonicalLedger, CanonicalItem } from "../../types/canonical";
import { classifyLedgerGroup } from "../balanceSheet";

// ─── Types ──────────────────────────────────────────────────────────

export interface MonthlyBI {
  month: string;
  label: string;
  revenue: number;
  expense: number;
  profit: number;
  revenueGrowth: number;   // % vs previous month
  expenseGrowth: number;
  profitMargin: number;     // profit / revenue %
}

export interface SeasonalCell {
  month: number;       // 0-11
  monthName: string;
  revenue: number;
  expense: number;
  profit: number;
  txCount: number;
}

export interface PatternDetection {
  type: "expense_cycle" | "behavior_change" | "ledger_spike" | "trend" | "seasonal";
  title: string;
  description: string;
  severity: "info" | "warning" | "danger" | "success";
  data?: { month: string; value: number }[];
}

export interface SmartInsight {
  icon: "trending_up" | "trending_down" | "alert" | "info" | "star";
  title: string;
  description: string;
  metric?: string;
  change?: number;
}

export interface ExpenseCategoryTrend {
  category: string;
  monthlyValues: { month: string; label: string; amount: number }[];
  total: number;
  trend: "rising" | "falling" | "stable";
  growthPct: number;
}

export interface BusinessIntelligenceResult {
  monthlyBI: MonthlyBI[];
  seasonalHeatmap: SeasonalCell[];
  patterns: PatternDetection[];
  insights: SmartInsight[];
  expenseTrends: ExpenseCategoryTrend[];
  summary: {
    revenueGrowthRate: number;
    expenseGrowthRate: number;
    profitTrend: "improving" | "declining" | "stable";
    avgProfitMargin: number;
    bestMonth: string;
    worstMonth: string;
    seasonalStrength: number; // 0-1 how seasonal the business is
  };
}

// ─── Helpers ────────────────────────────────────────────────────────
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function monthLabel(ym: string): string {
  const [y, m] = ym.split("-");
  return `${MONTH_NAMES[parseInt(m!, 10) - 1]} ${y!.slice(2)}`;
}

// ─── Main Computation ──────────────────────────────────────────────

export function computeBusinessIntelligence(
  vouchers: CanonicalVoucher[],
  ledgers: Map<string, CanonicalLedger>,
  _items: Map<string, CanonicalItem>,
): BusinessIntelligenceResult {
  // Monthly revenue/expense accumulation
  const monthlyMap = new Map<string, { revenue: number; expense: number; txCount: number }>();
  // Expense by category by month
  const categoryMonthly = new Map<string, Map<string, number>>();
  // Seasonal: aggregate by month-of-year
  const seasonalMap = new Map<number, { revenue: number; expense: number; txCount: number }>();

  for (const v of vouchers) {
    if (v.isCancelled || v.isOptional) continue;
    const ym = v.date.slice(0, 7);
    const monthIdx = parseInt(v.date.slice(5, 7), 10) - 1;

    // Skip non-operational vouchers from revenue/expense (Journal/Contra are balance adjustments)
    const isOperational = !["Journal", "Contra", "Stock Journal"].includes(v.voucherType);
    // DN/CN sign reversal: Credit Notes reduce revenue, Debit Notes reduce expenses
    const isReturn = v.voucherType === "Credit Note" || v.voucherType === "Debit Note";
    const sign = isReturn ? -1 : 1;

    let mm = monthlyMap.get(ym);
    if (!mm) { mm = { revenue: 0, expense: 0, txCount: 0 }; monthlyMap.set(ym, mm); }
    mm.txCount++;

    let sm = seasonalMap.get(monthIdx);
    if (!sm) { sm = { revenue: 0, expense: 0, txCount: 0 }; seasonalMap.set(monthIdx, sm); }
    sm.txCount++;

    if (!isOperational) continue;

    for (const line of v.lines) {
      if (line.type !== "ledger" || !line.ledgerId) continue;
      const ledger = ledgers.get(line.ledgerId);
      if (!ledger) continue;
      const cat = classifyLedgerGroup(ledger.group);
      const amt = line.amount ?? 0;

      if (cat === "income") {
        const rev = (line.isDebit ? -amt : amt) * sign;
        mm.revenue += rev;
        sm.revenue += rev;
      } else if (cat === "expense") {
        const exp = (line.isDebit ? amt : -amt) * sign;
        mm.expense += exp;
        sm.expense += exp;

        // Track by expense group
        const catName = ledger.group;
        let catMap = categoryMonthly.get(catName);
        if (!catMap) { catMap = new Map(); categoryMonthly.set(catName, catMap); }
        catMap.set(ym, (catMap.get(ym) ?? 0) + exp);
      }
    }
  }

  // Sort months
  const sortedMonths = Array.from(monthlyMap.keys()).sort();

  // Build monthly BI
  const monthlyBI: MonthlyBI[] = [];
  let prevRevenue = 0;
  let prevExpense = 0;
  for (const month of sortedMonths) {
    const m = monthlyMap.get(month)!;
    const profit = m.revenue - m.expense;
    const revenueGrowth = prevRevenue > 0 ? ((m.revenue - prevRevenue) / prevRevenue) * 100 : 0;
    const expenseGrowth = prevExpense > 0 ? ((m.expense - prevExpense) / prevExpense) * 100 : 0;
    monthlyBI.push({
      month,
      label: monthLabel(month),
      revenue: m.revenue,
      expense: m.expense,
      profit,
      revenueGrowth,
      expenseGrowth,
      profitMargin: m.revenue > 0 ? (profit / m.revenue) * 100 : 0,
    });
    prevRevenue = m.revenue;
    prevExpense = m.expense;
  }

  // Seasonal heatmap
  const seasonalHeatmap: SeasonalCell[] = [];
  for (let i = 0; i < 12; i++) {
    const s = seasonalMap.get(i);
    seasonalHeatmap.push({
      month: i,
      monthName: MONTH_NAMES[i]!,
      revenue: s?.revenue ?? 0,
      expense: s?.expense ?? 0,
      profit: (s?.revenue ?? 0) - (s?.expense ?? 0),
      txCount: s?.txCount ?? 0,
    });
  }

  // Expense category trends
  const expenseTrends: ExpenseCategoryTrend[] = [];
  for (const [category, monthMap] of categoryMonthly) {
    const values = sortedMonths.map(m => ({
      month: m,
      label: monthLabel(m),
      amount: monthMap.get(m) ?? 0,
    }));
    const total = values.reduce((s, v) => s + v.amount, 0);
    if (total < 10000) continue; // Skip trivial categories

    // Trend: compare last 3 vs first 3
    const first3 = values.slice(0, 3).reduce((s, v) => s + v.amount, 0) / 3;
    const last3 = values.slice(-3).reduce((s, v) => s + v.amount, 0) / 3;
    const growthPct = first3 > 0 ? ((last3 - first3) / first3) * 100 : 0;
    const trend: "rising" | "falling" | "stable" = growthPct > 15 ? "rising" : growthPct < -15 ? "falling" : "stable";

    expenseTrends.push({ category, monthlyValues: values, total, trend, growthPct });
  }
  expenseTrends.sort((a, b) => b.total - a.total);

  // Pattern detection
  const patterns = detectPatterns(monthlyBI, expenseTrends, seasonalHeatmap);

  // Summary
  const totalRevenue = monthlyBI.reduce((s, m) => s + m.revenue, 0);
  const totalExpense = monthlyBI.reduce((s, m) => s + m.expense, 0);
  const avgMargin = monthlyBI.length > 0
    ? monthlyBI.reduce((s, m) => s + m.profitMargin, 0) / monthlyBI.length
    : 0;

  // Overall growth: CAGR-like (last month / first month)
  const revenueGrowthRate = monthlyBI.length >= 2 && monthlyBI[0]!.revenue > 0
    ? ((monthlyBI[monthlyBI.length - 1]!.revenue / monthlyBI[0]!.revenue) - 1) * 100
    : 0;
  const expenseGrowthRate = monthlyBI.length >= 2 && monthlyBI[0]!.expense > 0
    ? ((monthlyBI[monthlyBI.length - 1]!.expense / monthlyBI[0]!.expense) - 1) * 100
    : 0;

  // Best/worst month by profit
  let bestMonth = "";
  let worstMonth = "";
  let bestProfit = -Infinity;
  let worstProfit = Infinity;
  for (const m of monthlyBI) {
    if (m.profit > bestProfit) { bestProfit = m.profit; bestMonth = m.label; }
    if (m.profit < worstProfit) { worstProfit = m.profit; worstMonth = m.label; }
  }

  // Profit trend: compare first half vs second half
  const half = Math.floor(monthlyBI.length / 2);
  const firstHalfProfit = monthlyBI.slice(0, half).reduce((s, m) => s + m.profit, 0) / (half || 1);
  const secondHalfProfit = monthlyBI.slice(half).reduce((s, m) => s + m.profit, 0) / ((monthlyBI.length - half) || 1);
  const profitTrend: "improving" | "declining" | "stable" =
    secondHalfProfit > firstHalfProfit * 1.1 ? "improving" :
    secondHalfProfit < firstHalfProfit * 0.9 ? "declining" : "stable";

  // Seasonal strength (coefficient of variation of monthly revenues)
  const monthlyRevenues = seasonalHeatmap.map(s => s.revenue).filter(r => r > 0);
  const avgRevenue = monthlyRevenues.length > 0 ? monthlyRevenues.reduce((s, v) => s + v, 0) / monthlyRevenues.length : 0;
  const revStdDev = monthlyRevenues.length > 1
    ? Math.sqrt(monthlyRevenues.reduce((s, v) => s + (v - avgRevenue) ** 2, 0) / monthlyRevenues.length)
    : 0;
  const seasonalStrength = avgRevenue > 0 ? Math.min(1, revStdDev / avgRevenue) : 0;

  // Generate smart insights
  const insights = generateSmartInsights(monthlyBI, profitTrend, revenueGrowthRate, expenseGrowthRate, avgMargin, seasonalHeatmap, expenseTrends);

  return {
    monthlyBI,
    seasonalHeatmap,
    patterns,
    insights,
    expenseTrends: expenseTrends.slice(0, 8),
    summary: {
      revenueGrowthRate,
      expenseGrowthRate,
      profitTrend,
      avgProfitMargin: avgMargin,
      bestMonth,
      worstMonth,
      seasonalStrength,
    },
  };
}

// ─── Pattern Detection ──────────────────────────────────────────────

function detectPatterns(
  monthly: MonthlyBI[],
  expenseTrends: ExpenseCategoryTrend[],
  seasonal: SeasonalCell[],
): PatternDetection[] {
  const patterns: PatternDetection[] = [];

  // Expense growing faster than revenue
  if (monthly.length >= 6) {
    const recentExpenseGrowth = monthly.slice(-3).reduce((s, m) => s + m.expenseGrowth, 0) / 3;
    const recentRevenueGrowth = monthly.slice(-3).reduce((s, m) => s + m.revenueGrowth, 0) / 3;
    if (recentExpenseGrowth > recentRevenueGrowth + 5) {
      patterns.push({
        type: "behavior_change",
        title: "Expenses Growing Faster Than Revenue",
        description: `Expenses growing ${recentExpenseGrowth.toFixed(0)}%/mo vs revenue ${recentRevenueGrowth.toFixed(0)}%/mo`,
        severity: "warning",
      });
    }
  }

  // Rising expense categories
  for (const cat of expenseTrends.filter(c => c.trend === "rising").slice(0, 2)) {
    patterns.push({
      type: "expense_cycle",
      title: `Rising Expense: ${cat.category}`,
      description: `${cat.category} expenses grew ${cat.growthPct.toFixed(0)}% over the period`,
      severity: cat.growthPct > 50 ? "danger" : "warning",
      data: cat.monthlyValues.map(v => ({ month: v.label, value: v.amount })),
    });
  }

  // Seasonal pattern: high variance across months
  const revenues = seasonal.map(s => s.revenue).filter(r => r > 0);
  if (revenues.length >= 6) {
    const max = Math.max(...revenues);
    const min = Math.min(...revenues);
    if (max > min * 2.5) {
      const peakMonth = seasonal.reduce((best, s) => s.revenue > best.revenue ? s : best, seasonal[0]!);
      patterns.push({
        type: "seasonal",
        title: "Strong Seasonal Pattern",
        description: `Peak revenue in ${peakMonth.monthName} — ${(max / min).toFixed(1)}x variation between highest and lowest months`,
        severity: "info",
      });
    }
  }

  // Consecutive profit decline (3+ months)
  let declineStreak = 0;
  for (let i = 1; i < monthly.length; i++) {
    if (monthly[i]!.profit < monthly[i - 1]!.profit) declineStreak++;
    else declineStreak = 0;
  }
  if (declineStreak >= 3) {
    patterns.push({
      type: "trend",
      title: "Profit Declining",
      description: `Profit has declined for ${declineStreak} consecutive months`,
      severity: "danger",
    });
  }

  return patterns;
}

// ─── Smart Insights ─────────────────────────────────────────────────

function generateSmartInsights(
  monthly: MonthlyBI[],
  profitTrend: string,
  revenueGrowth: number,
  expenseGrowth: number,
  avgMargin: number,
  seasonal: SeasonalCell[],
  expenseTrends: ExpenseCategoryTrend[],
): SmartInsight[] {
  const insights: SmartInsight[] = [];

  // Revenue trend
  insights.push({
    icon: revenueGrowth > 0 ? "trending_up" : revenueGrowth < 0 ? "trending_down" : "info",
    title: "Revenue Trend",
    description: `Revenue ${revenueGrowth > 0 ? "grew" : "declined"} ${Math.abs(revenueGrowth).toFixed(0)}% over the period`,
    metric: `${revenueGrowth >= 0 ? "+" : ""}${revenueGrowth.toFixed(0)}%`,
    change: revenueGrowth,
  });

  // Expense trend
  insights.push({
    icon: expenseGrowth > 10 ? "alert" : expenseGrowth < 0 ? "star" : "info",
    title: "Expense Trend",
    description: `Expenses ${expenseGrowth > 0 ? "increased" : "decreased"} ${Math.abs(expenseGrowth).toFixed(0)}% over the period`,
    metric: `${expenseGrowth >= 0 ? "+" : ""}${expenseGrowth.toFixed(0)}%`,
    change: expenseGrowth,
  });

  // Profit trend
  insights.push({
    icon: profitTrend === "improving" ? "trending_up" : profitTrend === "declining" ? "trending_down" : "info",
    title: "Profit Trajectory",
    description: `Profit is ${profitTrend} — average margin ${avgMargin.toFixed(1)}%`,
    metric: `${avgMargin.toFixed(1)}%`,
  });

  // Expenses vs revenue rate
  if (expenseGrowth > revenueGrowth + 10) {
    insights.push({
      icon: "alert",
      title: "Expense Alert",
      description: `Expenses growing ${(expenseGrowth - revenueGrowth).toFixed(0)}% faster than revenue — margin pressure`,
    });
  }

  // Peak season
  const peakMonth = seasonal.reduce((best, s) => s.revenue > best.revenue ? s : best, seasonal[0]!);
  if (peakMonth.revenue > 0) {
    insights.push({
      icon: "star",
      title: "Peak Season",
      description: `${peakMonth.monthName} is historically the strongest month for revenue`,
    });
  }

  // Top rising expense
  const topRising = expenseTrends.find(c => c.trend === "rising");
  if (topRising) {
    insights.push({
      icon: "alert",
      title: "Fastest Growing Expense",
      description: `${topRising.category} is rising at ${topRising.growthPct.toFixed(0)}% — worth investigating`,
    });
  }

  return insights;
}
