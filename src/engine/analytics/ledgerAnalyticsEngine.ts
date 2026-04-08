import type { CanonicalVoucher, CanonicalLedger } from "../../types/canonical";
import { classifyLedgerGroup, type BSCategory } from "../balanceSheet";

// ─── Types ──────────────────────────────────────────────────────────

export interface LedgerAnalytic {
  ledgerId: string;
  name: string;
  group: string;
  category: BSCategory;
  txCount: number;
  totalDebit: number;
  totalCredit: number;
  netAmount: number;
  monthlyTrend: MonthlyLedgerData[];
  growthRate: number;       // % change last 3 months vs prior 3
  volatility: number;       // CV of monthly amounts
  isDormant: boolean;       // No tx in last 3 months
  isNewHighActivity: boolean; // First appeared recently + high tx count
  firstTxDate: string;
  lastTxDate: string;
}

export interface MonthlyLedgerData {
  month: string;
  label: string;
  amount: number;
}

export interface LedgerInsight {
  type: "rising_expense" | "declining_income" | "new_active" | "dormant" | "high_frequency" | "info";
  title: string;
  description: string;
  severity: "info" | "warning" | "danger" | "success";
  ledgerId?: string;
}

export interface LedgerAnalyticsResult {
  allLedgers: LedgerAnalytic[];
  topIncome: LedgerAnalytic[];
  topExpense: LedgerAnalytic[];
  risingExpenses: LedgerAnalytic[];
  decliningIncome: LedgerAnalytic[];
  dormantLedgers: LedgerAnalytic[];
  newActiveLedgers: LedgerAnalytic[];
  insights: LedgerInsight[];
  summary: {
    totalLedgers: number;
    activeLedgers: number;
    dormantCount: number;
    topExpenseGroup: string;
    topIncomeGroup: string;
    avgTxPerLedger: number;
  };
}

// ─── Helpers ────────────────────────────────────────────────────────
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function monthLabel(ym: string): string {
  const [y, m] = ym.split("-");
  return `${MONTHS[parseInt(m!, 10) - 1]} ${y!.slice(2)}`;
}

function coefficientOfVariation(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  if (Math.abs(mean) < 1) return 0;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / Math.abs(mean);
}

// ─── Main Computation ──────────────────────────────────────────────

export function computeLedgerAnalytics(
  vouchers: CanonicalVoucher[],
  ledgers: Map<string, CanonicalLedger>,
): LedgerAnalyticsResult {
  // Per-ledger accumulation
  const ledgerData = new Map<string, {
    totalDebit: number;
    totalCredit: number;
    txCount: number;
    monthly: Map<string, number>;
    firstTx: string;
    lastTx: string;
  }>();

  // Find the range of months in data
  let minDate = "9999-99-99";
  let maxDate = "0000-00-00";

  for (const v of vouchers) {
    if (v.isCancelled || v.isOptional) continue;
    if (v.date < minDate) minDate = v.date;
    if (v.date > maxDate) maxDate = v.date;

    for (const line of v.lines) {
      if (line.type !== "ledger" || !line.ledgerId) continue;
      const amt = line.amount ?? 0;
      const ym = v.date.slice(0, 7);

      let ld = ledgerData.get(line.ledgerId);
      if (!ld) {
        ld = { totalDebit: 0, totalCredit: 0, txCount: 0, monthly: new Map(), firstTx: v.date, lastTx: v.date };
        ledgerData.set(line.ledgerId, ld);
      }

      if (line.isDebit) ld.totalDebit += amt; else ld.totalCredit += amt;
      ld.txCount++;
      ld.monthly.set(ym, (ld.monthly.get(ym) ?? 0) + amt);
      if (v.date < ld.firstTx) ld.firstTx = v.date;
      if (v.date > ld.lastTx) ld.lastTx = v.date;
    }
  }

  // Determine "last 3 months" from data
  const maxYM = maxDate.slice(0, 7);
  const maxD = new Date(maxDate);
  const threeMonthsAgo = new Date(maxD);
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
  const threeMonthsAgoYM = threeMonthsAgo.toISOString().slice(0, 7);
  const sixMonthsAgo = new Date(maxD);
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  const sixMonthsAgoYM = sixMonthsAgo.toISOString().slice(0, 7);

  // Build all months range
  const allMonths: string[] = [];
  const cur = new Date(minDate);
  while (cur.toISOString().slice(0, 7) <= maxYM) {
    allMonths.push(cur.toISOString().slice(0, 7));
    cur.setMonth(cur.getMonth() + 1);
  }

  // Build analytics
  const allLedgers: LedgerAnalytic[] = [];
  const totalTx = Array.from(ledgerData.values()).reduce((s, d) => s + d.txCount, 0);

  for (const [ledgerId, ld] of ledgerData) {
    const ledger = ledgers.get(ledgerId);
    if (!ledger) continue;
    const category = classifyLedgerGroup(ledger.group);

    // Monthly trend
    const monthlyTrend: MonthlyLedgerData[] = allMonths.map(m => ({
      month: m,
      label: monthLabel(m),
      amount: ld.monthly.get(m) ?? 0,
    }));

    const monthlyAmounts = monthlyTrend.map(m => m.amount);
    const volatility = coefficientOfVariation(monthlyAmounts.filter(a => a > 0));

    // Growth rate: compare recent 3mo vs prior 3mo
    const recent3 = monthlyTrend.filter(m => m.month > threeMonthsAgoYM && m.month <= maxYM);
    const prior3 = monthlyTrend.filter(m => m.month > sixMonthsAgoYM && m.month <= threeMonthsAgoYM);
    const recentAvg = recent3.length > 0 ? recent3.reduce((s, m) => s + m.amount, 0) / recent3.length : 0;
    const priorAvg = prior3.length > 0 ? prior3.reduce((s, m) => s + m.amount, 0) / prior3.length : 0;
    const growthRate = priorAvg > 0 ? ((recentAvg - priorAvg) / priorAvg) * 100 : 0;

    // Dormancy: no transactions in last 3 months
    const isDormant = ld.lastTx < threeMonthsAgo.toISOString().slice(0, 10) && ld.txCount > 0;

    // New high activity: first tx within last 3 months + high tx count
    const isNewHighActivity = ld.firstTx >= threeMonthsAgo.toISOString().slice(0, 10) && ld.txCount >= 10;

    const netAmount = category === "expense" ? ld.totalDebit - ld.totalCredit :
                      category === "income" ? ld.totalCredit - ld.totalDebit :
                      ld.totalDebit - ld.totalCredit;

    allLedgers.push({
      ledgerId,
      name: ledger.name,
      group: ledger.group,
      category,
      txCount: ld.txCount,
      totalDebit: ld.totalDebit,
      totalCredit: ld.totalCredit,
      netAmount: Math.abs(netAmount),
      monthlyTrend,
      growthRate,
      volatility,
      isDormant,
      isNewHighActivity,
      firstTxDate: ld.firstTx,
      lastTxDate: ld.lastTx,
    });
  }

  // Sort and categorize
  const topIncome = allLedgers
    .filter(l => l.category === "income")
    .sort((a, b) => b.netAmount - a.netAmount)
    .slice(0, 10);

  const topExpense = allLedgers
    .filter(l => l.category === "expense")
    .sort((a, b) => b.netAmount - a.netAmount)
    .slice(0, 10);

  const risingExpenses = allLedgers
    .filter(l => l.category === "expense" && l.growthRate > 20 && l.txCount >= 5)
    .sort((a, b) => b.growthRate - a.growthRate)
    .slice(0, 5);

  const decliningIncome = allLedgers
    .filter(l => l.category === "income" && l.growthRate < -20 && l.txCount >= 5)
    .sort((a, b) => a.growthRate - b.growthRate)
    .slice(0, 5);

  const dormantLedgers = allLedgers
    .filter(l => l.isDormant)
    .sort((a, b) => b.txCount - a.txCount)
    .slice(0, 10);

  const newActiveLedgers = allLedgers
    .filter(l => l.isNewHighActivity)
    .sort((a, b) => b.txCount - a.txCount)
    .slice(0, 5);

  // Insights
  const insights = generateLedgerInsights(risingExpenses, decliningIncome, dormantLedgers, newActiveLedgers, topExpense, topIncome);

  // Summary
  const activeLedgers = allLedgers.filter(l => !l.isDormant).length;
  const expenseGroups = new Map<string, number>();
  const incomeGroups = new Map<string, number>();
  for (const l of allLedgers) {
    if (l.category === "expense") expenseGroups.set(l.group, (expenseGroups.get(l.group) ?? 0) + l.netAmount);
    if (l.category === "income") incomeGroups.set(l.group, (incomeGroups.get(l.group) ?? 0) + l.netAmount);
  }
  const topExpenseGroup = Array.from(expenseGroups.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "N/A";
  const topIncomeGroup = Array.from(incomeGroups.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "N/A";

  return {
    allLedgers,
    topIncome,
    topExpense,
    risingExpenses,
    decliningIncome,
    dormantLedgers,
    newActiveLedgers,
    insights,
    summary: {
      totalLedgers: allLedgers.length,
      activeLedgers,
      dormantCount: dormantLedgers.length,
      topExpenseGroup,
      topIncomeGroup,
      avgTxPerLedger: allLedgers.length > 0 ? totalTx / allLedgers.length : 0,
    },
  };
}

// ─── Insights ───────────────────────────────────────────────────────

function generateLedgerInsights(
  rising: LedgerAnalytic[],
  declining: LedgerAnalytic[],
  dormant: LedgerAnalytic[],
  newActive: LedgerAnalytic[],
  topExpense: LedgerAnalytic[],
  topIncome: LedgerAnalytic[],
): LedgerInsight[] {
  const insights: LedgerInsight[] = [];

  for (const l of rising.slice(0, 2)) {
    insights.push({
      type: "rising_expense",
      title: "Rising Expense",
      description: `${l.name} expenses grew ${l.growthRate.toFixed(0)}% (₹${(l.netAmount / 100000).toFixed(1)}L total)`,
      severity: l.growthRate > 50 ? "danger" : "warning",
      ledgerId: l.ledgerId,
    });
  }

  for (const l of declining.slice(0, 2)) {
    insights.push({
      type: "declining_income",
      title: "Declining Income",
      description: `${l.name} income dropped ${Math.abs(l.growthRate).toFixed(0)}% recently`,
      severity: "warning",
      ledgerId: l.ledgerId,
    });
  }

  if (dormant.length > 0) {
    insights.push({
      type: "dormant",
      title: "Dormant Ledgers",
      description: `${dormant.length} ledger(s) have had no activity for 3+ months`,
      severity: "info",
    });
  }

  for (const l of newActive.slice(0, 1)) {
    insights.push({
      type: "new_active",
      title: "New High-Activity Ledger",
      description: `${l.name} is new and already has ${l.txCount} transactions`,
      severity: "info",
      ledgerId: l.ledgerId,
    });
  }

  if (topExpense.length > 0) {
    insights.push({
      type: "info",
      title: "Top Expense Ledger",
      description: `${topExpense[0]!.name} is the largest expense at ₹${(topExpense[0]!.netAmount / 100000).toFixed(1)}L`,
      severity: "info",
    });
  }

  return insights;
}
