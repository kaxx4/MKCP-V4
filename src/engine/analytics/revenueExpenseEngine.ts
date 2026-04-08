import type { CanonicalVoucher, CanonicalLedger } from "../../types/canonical";
import { classifyLedgerGroup, type BSCategory } from "../balanceSheet";

// ─── Types ──────────────────────────────────────────────────────────

export interface DailyMetric {
  date: string;
  revenue: number;
  expense: number;
  netProfit: number;
}

export interface MonthlyMetric {
  month: string;   // "YYYY-MM"
  label: string;   // "Mar 25"
  revenue: number;
  expense: number;
  netProfit: number;
}

export interface LedgerRank {
  ledgerId: string;
  name: string;
  group: string;
  total: number;
  txCount: number;
  pctOfTotal: number;
}

export interface ExpenseCategory {
  category: string;
  total: number;
  pct: number;
}

export interface LargeTransaction {
  date: string;
  voucherNumber: string;
  voucherType: string;
  partyName: string;
  amount: number;
  ledgerName: string;
}

export interface FinancialInsight {
  type: "info" | "warning" | "success" | "danger";
  title: string;
  description: string;
}

export interface RevenueExpenseAnalysis {
  dailyMetrics: DailyMetric[];
  monthlyMetrics: MonthlyMetric[];
  topIncomeLedgers: LedgerRank[];
  topExpenseLedgers: LedgerRank[];
  expenseCategories: ExpenseCategory[];
  largestTransactions: LargeTransaction[];
  insights: FinancialInsight[];
  summary: {
    totalRevenue: number;
    totalExpense: number;
    netProfit: number;
    avgDailyRevenue: number;
    avgDailyExpense: number;
    avgDailyCashFlow: number;
    revenueGrowthPct: number;
    activeDays: number;
  };
}

// ─── Month label helper ─────────────────────────────────────────────
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function monthLabel(ym: string): string {
  const [y, m] = ym.split("-");
  return `${MONTHS[parseInt(m!, 10) - 1]} ${y!.slice(2)}`;
}

// ─── Main Computation ──────────────────────────────────────────────

export function computeRevenueExpenseAnalysis(
  vouchers: CanonicalVoucher[],
  ledgers: Map<string, CanonicalLedger>,
): RevenueExpenseAnalysis {
  // Accumulators
  const dailyRevenue = new Map<string, number>();
  const dailyExpense = new Map<string, number>();
  const ledgerTotals = new Map<string, { debit: number; credit: number; txCount: number }>();
  const largeTransactions: LargeTransaction[] = [];

  // Single pass over vouchers
  for (const v of vouchers) {
    if (v.isCancelled || v.isOptional) continue;

    // Skip non-operational vouchers from revenue/expense (Journal/Contra are balance adjustments)
    const isOperational = !["Journal", "Contra", "Stock Journal"].includes(v.voucherType);
    // DN/CN sign reversal: Credit Notes reduce revenue, Debit Notes reduce expenses
    const isReturn = v.voucherType === "Credit Note" || v.voucherType === "Debit Note";
    const sign = isReturn ? -1 : 1;

    for (const line of v.lines) {
      if (line.type !== "ledger" || !line.ledgerId) continue;
      const ledger = ledgers.get(line.ledgerId);
      if (!ledger) continue;

      const cat = classifyLedgerGroup(ledger.group);
      const amt = line.amount ?? 0;

      // Track ledger totals (all voucher types for ledger ranking)
      let lt = ledgerTotals.get(line.ledgerId);
      if (!lt) { lt = { debit: 0, credit: 0, txCount: 0 }; ledgerTotals.set(line.ledgerId, lt); }
      if (line.isDebit) lt.debit += amt; else lt.credit += amt;
      lt.txCount++;

      // Revenue/expense only from operational vouchers (Sales, Purchase, Receipt, Payment, DN, CN)
      if (!isOperational) continue;

      // Revenue: credit to income ledgers (flipped for Credit Notes)
      if (cat === "income") {
        const rev = (line.isDebit ? -amt : amt) * sign;
        dailyRevenue.set(v.date, (dailyRevenue.get(v.date) ?? 0) + rev);
      }

      // Expense: debit to expense ledgers (flipped for Debit Notes)
      if (cat === "expense") {
        const exp = (line.isDebit ? amt : -amt) * sign;
        dailyExpense.set(v.date, (dailyExpense.get(v.date) ?? 0) + exp);
      }

      // Track large transactions (>50k)
      if (amt > 50000) {
        largeTransactions.push({
          date: v.date,
          voucherNumber: v.voucherNumber,
          voucherType: v.voucherType,
          partyName: v.partyName ?? ledger.name,
          amount: amt,
          ledgerName: ledger.name,
        });
      }
    }
  }

  // Build daily metrics (sorted by date)
  const allDates = new Set([...dailyRevenue.keys(), ...dailyExpense.keys()]);
  const dailyMetrics: DailyMetric[] = Array.from(allDates)
    .sort()
    .map(date => ({
      date,
      revenue: dailyRevenue.get(date) ?? 0,
      expense: dailyExpense.get(date) ?? 0,
      netProfit: (dailyRevenue.get(date) ?? 0) - (dailyExpense.get(date) ?? 0),
    }));

  // Build monthly metrics
  const monthlyMap = new Map<string, { revenue: number; expense: number }>();
  for (const d of dailyMetrics) {
    const ym = d.date.slice(0, 7);
    let m = monthlyMap.get(ym);
    if (!m) { m = { revenue: 0, expense: 0 }; monthlyMap.set(ym, m); }
    m.revenue += d.revenue;
    m.expense += d.expense;
  }
  const monthlyMetrics: MonthlyMetric[] = Array.from(monthlyMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, m]) => ({
      month,
      label: monthLabel(month),
      revenue: m.revenue,
      expense: m.expense,
      netProfit: m.revenue - m.expense,
    }));

  // Top income/expense ledgers
  const totalRevenue = monthlyMetrics.reduce((s, m) => s + m.revenue, 0);
  const totalExpense = monthlyMetrics.reduce((s, m) => s + m.expense, 0);

  const incomeLedgers: LedgerRank[] = [];
  const expenseLedgers: LedgerRank[] = [];
  const categoryMap = new Map<string, number>();

  for (const [ledgerId, totals] of ledgerTotals) {
    const ledger = ledgers.get(ledgerId);
    if (!ledger) continue;
    const cat = classifyLedgerGroup(ledger.group);

    if (cat === "income") {
      const total = totals.credit - totals.debit;
      if (total > 0) {
        incomeLedgers.push({
          ledgerId, name: ledger.name, group: ledger.group,
          total, txCount: totals.txCount,
          pctOfTotal: totalRevenue > 0 ? (total / totalRevenue) * 100 : 0,
        });
      }
    } else if (cat === "expense") {
      const total = totals.debit - totals.credit;
      if (total > 0) {
        expenseLedgers.push({
          ledgerId, name: ledger.name, group: ledger.group,
          total, txCount: totals.txCount,
          pctOfTotal: totalExpense > 0 ? (total / totalExpense) * 100 : 0,
        });
        // Category accumulation
        const catName = ledger.group || "Uncategorized";
        categoryMap.set(catName, (categoryMap.get(catName) ?? 0) + total);
      }
    }
  }

  incomeLedgers.sort((a, b) => b.total - a.total);
  expenseLedgers.sort((a, b) => b.total - a.total);

  const topIncomeLedgers = incomeLedgers.slice(0, 10);
  const topExpenseLedgers = expenseLedgers.slice(0, 10);

  // Expense categories
  const expenseCategories: ExpenseCategory[] = Array.from(categoryMap.entries())
    .map(([category, total]) => ({
      category,
      total,
      pct: totalExpense > 0 ? (total / totalExpense) * 100 : 0,
    }))
    .sort((a, b) => b.total - a.total);

  // Largest transactions (sorted, top 20)
  largeTransactions.sort((a, b) => b.amount - a.amount);
  const top20Transactions = largeTransactions.slice(0, 20);

  // Summary
  const activeDays = dailyMetrics.length;
  const netProfit = totalRevenue - totalExpense;

  // Revenue growth: compare last 2 months
  let revenueGrowthPct = 0;
  if (monthlyMetrics.length >= 2) {
    const last = monthlyMetrics[monthlyMetrics.length - 1]!.revenue;
    const prev = monthlyMetrics[monthlyMetrics.length - 2]!.revenue;
    if (prev > 0) revenueGrowthPct = ((last - prev) / prev) * 100;
  }

  // Generate insights
  const insights = generateInsights(
    topExpenseLedgers, totalRevenue, totalExpense, revenueGrowthPct,
    dailyMetrics, monthlyMetrics, expenseLedgers
  );

  return {
    dailyMetrics,
    monthlyMetrics,
    topIncomeLedgers,
    topExpenseLedgers,
    expenseCategories,
    largestTransactions: top20Transactions,
    insights,
    summary: {
      totalRevenue,
      totalExpense,
      netProfit,
      avgDailyRevenue: activeDays > 0 ? totalRevenue / activeDays : 0,
      avgDailyExpense: activeDays > 0 ? totalExpense / activeDays : 0,
      avgDailyCashFlow: activeDays > 0 ? netProfit / activeDays : 0,
      revenueGrowthPct,
      activeDays,
    },
  };
}

// ─── Insight Generation ─────────────────────────────────────────────

function generateInsights(
  topExpense: LedgerRank[],
  totalRevenue: number,
  totalExpense: number,
  revenueGrowth: number,
  dailyMetrics: DailyMetric[],
  monthlyMetrics: MonthlyMetric[],
  allExpenseLedgers: LedgerRank[],
): FinancialInsight[] {
  const insights: FinancialInsight[] = [];

  // Biggest expense driver
  if (topExpense.length > 0) {
    const top = topExpense[0]!;
    insights.push({
      type: "info",
      title: "Biggest Expense Driver",
      description: `${top.name} accounts for ${top.pctOfTotal.toFixed(1)}% of total expenses (₹${(top.total / 100000).toFixed(1)}L)`,
    });
  }

  // Revenue growth
  if (revenueGrowth !== 0) {
    insights.push({
      type: revenueGrowth > 0 ? "success" : "warning",
      title: "Revenue Trend",
      description: `Revenue ${revenueGrowth > 0 ? "grew" : "declined"} ${Math.abs(revenueGrowth).toFixed(1)}% month-over-month`,
    });
  }

  // Profit margin
  if (totalRevenue > 0) {
    const margin = ((totalRevenue - totalExpense) / totalRevenue) * 100;
    insights.push({
      type: margin > 10 ? "success" : margin > 0 ? "info" : "danger",
      title: "Profit Margin",
      description: `Net profit margin is ${margin.toFixed(1)}% (₹${((totalRevenue - totalExpense) / 100000).toFixed(1)}L profit on ₹${(totalRevenue / 100000).toFixed(1)}L revenue)`,
    });
  }

  // Negative cash flow days
  const negativeDays = dailyMetrics.filter(d => d.netProfit < 0).length;
  if (negativeDays > dailyMetrics.length * 0.3) {
    insights.push({
      type: "warning",
      title: "Cash Flow Warning",
      description: `Net negative cash flow on ${negativeDays} of ${dailyMetrics.length} active days (${((negativeDays / dailyMetrics.length) * 100).toFixed(0)}%)`,
    });
  }

  // Spending spike detection: find ledgers where last month > 2x average
  if (monthlyMetrics.length >= 3) {
    for (const ledger of allExpenseLedgers.slice(0, 5)) {
      const avgMonthly = ledger.total / monthlyMetrics.length;
      // This is a simplified check - the detailed cashflow engine does per-month analysis
      if (ledger.total > avgMonthly * 2 && ledger.txCount > 3) {
        insights.push({
          type: "warning",
          title: "High Activity Expense",
          description: `${ledger.name} has ${ledger.txCount} transactions totaling ₹${(ledger.total / 100000).toFixed(1)}L`,
        });
        break; // Only show one spike
      }
    }
  }

  return insights;
}
