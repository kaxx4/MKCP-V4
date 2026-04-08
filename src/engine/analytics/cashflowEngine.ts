import type { CanonicalVoucher, CanonicalLedger } from "../../types/canonical";
import { classifyLedgerGroup } from "../balanceSheet";

// ─── Types ──────────────────────────────────────────────────────────

export interface DailyCashflow {
  date: string;
  inflow: number;
  outflow: number;
  net: number;
}

export interface WeeklyCashflow {
  weekStart: string;
  weekLabel: string;
  inflow: number;
  outflow: number;
  net: number;
}

export interface MonthlyCashflow {
  month: string;
  label: string;
  inflow: number;
  outflow: number;
  net: number;
  cumulative: number;
}

export interface CashflowAnomaly {
  date: string;
  voucherNumber: string;
  voucherType: string;
  amount: number;
  ledgerName: string;
  partyName: string;
  multiplier: number; // How many times above average
  type: "large_outflow" | "large_inflow" | "spike";
}

export interface CashflowPrediction {
  date: string;
  predictedNet: number;
  upperBound: number;
  lowerBound: number;
}

export interface CashflowWarning {
  type: "trend_increasing_outflow" | "spike_detected" | "projected_crunch" | "volatility_high" | "info";
  title: string;
  description: string;
  severity: "info" | "warning" | "danger";
}

export interface CashflowAnalysis {
  daily: DailyCashflow[];
  weekly: WeeklyCashflow[];
  monthly: MonthlyCashflow[];
  anomalies: CashflowAnomaly[];
  predictions: CashflowPrediction[];
  warnings: CashflowWarning[];
  topOutflows: CashflowAnomaly[];
  summary: {
    totalInflow: number;
    totalOutflow: number;
    netCashflow: number;
    avgDailyInflow: number;
    avgDailyOutflow: number;
    volatility: number; // Coefficient of variation of daily net
    peakInflow: number;
    peakOutflow: number;
    currentBankBalance: number;
  };
}

// ─── Helpers ─────────────────────────────────────────────────────

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function monthLabel(ym: string): string {
  const [y, m] = ym.split("-");
  return `${MONTHS[parseInt(m!, 10) - 1]} ${y!.slice(2)}`;
}

function getWeekStart(dateStr: string): string {
  const d = new Date(dateStr);
  const day = d.getDay();
  d.setDate(d.getDate() - day); // Sunday start
  return d.toISOString().slice(0, 10);
}

function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

// ─── Main Computation ──────────────────────────────────────────────

export function computeCashflowAnalysis(
  vouchers: CanonicalVoucher[],
  ledgers: Map<string, CanonicalLedger>,
): CashflowAnalysis {
  // Cash/bank flow accumulators (Receipt=inflow, Payment=outflow, plus ledger-level analysis)
  const dailyInflow = new Map<string, number>();
  const dailyOutflow = new Map<string, number>();
  const anomalyCandidates: CashflowAnomaly[] = [];

  // Compute bank opening balance
  let bankBalance = 0;
  for (const [, ledger] of ledgers) {
    const g = ledger.group.toLowerCase();
    if (g.includes("bank") || g.includes("cash")) {
      bankBalance += ledger.openingBalance;
    }
  }

  // Single pass - track cash movement vouchers
  for (const v of vouchers) {
    if (v.isCancelled || v.isOptional) continue;

    // Receipt = cash inflow, Payment = cash outflow, Sales/Purchase via cash/bank
    let voucherInflow = 0;
    let voucherOutflow = 0;

    for (const line of v.lines) {
      if (line.type !== "ledger" || !line.ledgerId) continue;
      const ledger = ledgers.get(line.ledgerId);
      if (!ledger) continue;

      const g = ledger.group.toLowerCase();
      const isCashBank = g.includes("bank") || g.includes("cash");
      const amt = line.amount ?? 0;

      if (isCashBank) {
        // Debit to cash/bank = inflow, Credit = outflow
        if (line.isDebit) {
          voucherInflow += amt;
        } else {
          voucherOutflow += amt;
        }
      }
    }

    if (voucherInflow > 0) {
      dailyInflow.set(v.date, (dailyInflow.get(v.date) ?? 0) + voucherInflow);
    }
    if (voucherOutflow > 0) {
      dailyOutflow.set(v.date, (dailyOutflow.get(v.date) ?? 0) + voucherOutflow);
    }

    // Track large transactions for anomaly detection
    const totalAmt = Math.max(voucherInflow, voucherOutflow);
    if (totalAmt > 0) {
      anomalyCandidates.push({
        date: v.date,
        voucherNumber: v.voucherNumber,
        voucherType: v.voucherType,
        amount: totalAmt,
        ledgerName: v.partyName ?? "",
        partyName: v.partyName ?? "",
        multiplier: 0, // Calculated later
        type: voucherInflow > voucherOutflow ? "large_inflow" : "large_outflow",
      });
    }
  }

  // Build daily metrics
  const allDates = new Set([...dailyInflow.keys(), ...dailyOutflow.keys()]);
  const daily: DailyCashflow[] = Array.from(allDates).sort().map(date => ({
    date,
    inflow: dailyInflow.get(date) ?? 0,
    outflow: dailyOutflow.get(date) ?? 0,
    net: (dailyInflow.get(date) ?? 0) - (dailyOutflow.get(date) ?? 0),
  }));

  // Weekly aggregation
  const weeklyMap = new Map<string, { inflow: number; outflow: number }>();
  for (const d of daily) {
    const ws = getWeekStart(d.date);
    let w = weeklyMap.get(ws);
    if (!w) { w = { inflow: 0, outflow: 0 }; weeklyMap.set(ws, w); }
    w.inflow += d.inflow;
    w.outflow += d.outflow;
  }
  const weekly: WeeklyCashflow[] = Array.from(weeklyMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([weekStart, w]) => ({
      weekStart,
      weekLabel: `W${weekStart.slice(8, 10)}/${weekStart.slice(5, 7)}`,
      inflow: w.inflow,
      outflow: w.outflow,
      net: w.inflow - w.outflow,
    }));

  // Monthly aggregation with cumulative
  const monthlyMap = new Map<string, { inflow: number; outflow: number }>();
  for (const d of daily) {
    const ym = d.date.slice(0, 7);
    let m = monthlyMap.get(ym);
    if (!m) { m = { inflow: 0, outflow: 0 }; monthlyMap.set(ym, m); }
    m.inflow += d.inflow;
    m.outflow += d.outflow;
  }
  let cumulative = bankBalance;
  const monthly: MonthlyCashflow[] = Array.from(monthlyMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, m]) => {
      cumulative += m.inflow - m.outflow;
      return {
        month,
        label: monthLabel(month),
        inflow: m.inflow,
        outflow: m.outflow,
        net: m.inflow - m.outflow,
        cumulative,
      };
    });

  // Anomaly detection: transactions > 3x average daily
  const avgDailyAmt = anomalyCandidates.length > 0
    ? anomalyCandidates.reduce((s, a) => s + a.amount, 0) / daily.length
    : 0;
  const threshold = avgDailyAmt * 3;

  const anomalies: CashflowAnomaly[] = anomalyCandidates
    .filter(a => a.amount > threshold && a.amount > 50000)
    .map(a => ({ ...a, multiplier: avgDailyAmt > 0 ? a.amount / avgDailyAmt : 0 }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 15);

  // Top outflows (regardless of anomaly threshold)
  const topOutflows = anomalyCandidates
    .filter(a => a.type === "large_outflow")
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 10);

  // Summary stats
  const totalInflow = daily.reduce((s, d) => s + d.inflow, 0);
  const totalOutflow = daily.reduce((s, d) => s + d.outflow, 0);
  const dailyNets = daily.map(d => d.net);
  const volatility = dailyNets.length > 0
    ? stddev(dailyNets) / (Math.abs(dailyNets.reduce((s, v) => s + v, 0) / dailyNets.length) || 1)
    : 0;

  // 30-day prediction based on monthly averages
  const predictions = generate30DayPrediction(monthly, daily);

  // Warnings
  const warnings = generateWarnings(monthly, anomalies, volatility, totalInflow, totalOutflow, predictions);

  // Current bank balance = opening + net movements
  const currentBalance = bankBalance + totalInflow - totalOutflow;

  return {
    daily,
    weekly,
    monthly,
    anomalies,
    predictions,
    warnings,
    topOutflows,
    summary: {
      totalInflow,
      totalOutflow,
      netCashflow: totalInflow - totalOutflow,
      avgDailyInflow: daily.length > 0 ? totalInflow / daily.length : 0,
      avgDailyOutflow: daily.length > 0 ? totalOutflow / daily.length : 0,
      volatility: Math.abs(volatility),
      peakInflow: daily.reduce((max, d) => Math.max(max, d.inflow), 0),
      peakOutflow: daily.reduce((max, d) => Math.max(max, d.outflow), 0),
      currentBankBalance: currentBalance,
    },
  };
}

// ─── 30-Day Prediction ──────────────────────────────────────────────

function generate30DayPrediction(
  monthly: MonthlyCashflow[],
  daily: DailyCashflow[],
): CashflowPrediction[] {
  if (monthly.length < 2) return [];

  // Use last 3 months average daily net
  const last3Months = monthly.slice(-3);
  const avgMonthlyNet = last3Months.reduce((s, m) => s + m.net, 0) / last3Months.length;
  const avgDailyNet = avgMonthlyNet / 30;

  // Compute daily volatility for bounds
  const recentDaily = daily.slice(-90);
  const dailyNets = recentDaily.map(d => d.net);
  const sd = stddev(dailyNets);

  const lastDate = daily.length > 0 ? daily[daily.length - 1]!.date : new Date().toISOString().slice(0, 10);
  const predictions: CashflowPrediction[] = [];

  for (let i = 1; i <= 30; i++) {
    const d = new Date(lastDate);
    d.setDate(d.getDate() + i);
    const date = d.toISOString().slice(0, 10);
    predictions.push({
      date,
      predictedNet: avgDailyNet * i,
      upperBound: (avgDailyNet + sd * 0.5) * i,
      lowerBound: (avgDailyNet - sd * 0.5) * i,
    });
  }
  return predictions;
}

// ─── Warnings ───────────────────────────────────────────────────────

function generateWarnings(
  monthly: MonthlyCashflow[],
  anomalies: CashflowAnomaly[],
  volatility: number,
  totalInflow: number,
  totalOutflow: number,
  predictions: CashflowPrediction[],
): CashflowWarning[] {
  const warnings: CashflowWarning[] = [];

  // Outflow trend increasing
  if (monthly.length >= 3) {
    const recent3 = monthly.slice(-3);
    const isIncreasing = recent3.every((m, i) => i === 0 || m.outflow >= recent3[i - 1]!.outflow * 0.95);
    if (isIncreasing && recent3.length === 3) {
      const pctIncrease = recent3[0]!.outflow > 0
        ? ((recent3[2]!.outflow - recent3[0]!.outflow) / recent3[0]!.outflow) * 100
        : 0;
      if (pctIncrease > 5) {
        warnings.push({
          type: "trend_increasing_outflow",
          title: "Outflow Trend Increasing",
          description: `Cash outflow has increased ${pctIncrease.toFixed(0)}% over the last 3 months`,
          severity: pctIncrease > 20 ? "danger" : "warning",
        });
      }
    }
  }

  // Anomaly-based spike
  if (anomalies.length > 0) {
    const top = anomalies[0]!;
    warnings.push({
      type: "spike_detected",
      title: "Unusual Transaction Detected",
      description: `₹${(top.amount / 100000).toFixed(1)}L ${top.type === "large_outflow" ? "outflow" : "inflow"} on ${top.date} (${top.multiplier.toFixed(1)}x average)`,
      severity: "warning",
    });
  }

  // High volatility
  if (volatility > 2) {
    warnings.push({
      type: "volatility_high",
      title: "High Cash Flow Volatility",
      description: `Daily cash flow variation is ${volatility.toFixed(1)}x the mean — indicates unpredictable flow`,
      severity: "warning",
    });
  }

  // Projected crunch
  if (predictions.length > 0) {
    const day30 = predictions[predictions.length - 1]!;
    if (day30.lowerBound < -500000) {
      warnings.push({
        type: "projected_crunch",
        title: "Potential Cash Crunch",
        description: `Worst-case projection shows ₹${(Math.abs(day30.lowerBound) / 100000).toFixed(1)}L deficit in 30 days`,
        severity: "danger",
      });
    }
  }

  return warnings;
}
