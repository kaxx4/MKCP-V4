import type { CanonicalLedger, CanonicalVoucher, TallyPLSnapshot } from "../types/canonical";
import { computeProfitAndLoss, classifyLedgerGroup } from "./balanceSheet";

// ─── Indian Advance Income Tax Computation ──────────────────────────────
// For companies: Section 115BAA (new regime) = 22% + 10% surcharge + 4% cess
// For firms/individuals: standard slab rates apply
// Advance tax installments: 15% by Jun 15, 45% by Sep 15, 75% by Dec 15, 100% by Mar 15

export interface TaxSlab {
  label: string;
  rate: number;        // percentage
  surchargeRate: number;
  cessRate: number;
  effectiveRate: number;
}

export const COMPANY_TAX_REGIMES: Record<string, TaxSlab> = {
  "Section 115BAA (New Regime)": {
    label: "Section 115BAA (New Regime)",
    rate: 22,
    surchargeRate: 10,
    cessRate: 4,
    effectiveRate: 25.168, // 22 * 1.10 * 1.04
  },
  "Section 115BAB (Manufacturing)": {
    label: "Section 115BAB (Manufacturing)",
    rate: 15,
    surchargeRate: 10,
    cessRate: 4,
    effectiveRate: 17.16, // 15 * 1.10 * 1.04
  },
  "Old Regime (Turnover <= 400Cr)": {
    label: "Old Regime (Turnover <= 400Cr)",
    rate: 25,
    surchargeRate: 7,
    cessRate: 4,
    effectiveRate: 27.82,
  },
  "Old Regime (Turnover > 400Cr)": {
    label: "Old Regime (Turnover > 400Cr)",
    rate: 30,
    surchargeRate: 7,
    cessRate: 4,
    effectiveRate: 33.384,
  },
};

export interface QuarterlyInstallment {
  quarter: string;          // "Q1", "Q2", "Q3", "Q4"
  label: string;            // "Apr-Jun"
  dueDate: string;          // "Jun 15"
  cumulativePct: number;    // 15%, 45%, 75%, 100%
  installmentPct: number;   // 15%, 30%, 30%, 25%
  cumulativeAmount: number;
  installmentAmount: number;
  profitToDate: number;     // P&L to the end of this quarter
}

export interface AdvanceTaxData {
  regime: TaxSlab;
  fyYear: string;           // "2025-26"
  annualProfit: number;     // estimated from P&L
  annualTurnover: number;
  taxableIncome: number;
  basicTax: number;
  surcharge: number;
  cess: number;
  totalTax: number;
  quarters: QuarterlyInstallment[];
  monthlyProfitTrend: { month: string; profit: number; cumulative: number }[];
}

export function computeAdvanceTax(
  ledgers: Map<string, CanonicalLedger>,
  vouchers: CanonicalVoucher[],
  regimeKey: string = "Section 115BAA (New Regime)",
  fyStartMonth: number = 4, // April
  tallyPL?: TallyPLSnapshot
): AdvanceTaxData {
  const regime = COMPANY_TAX_REGIMES[regimeKey] ?? COMPANY_TAX_REGIMES["Section 115BAA (New Regime)"];

  // Compute P&L (use Tally's authoritative stock values if available)
  const pl = computeProfitAndLoss(ledgers, vouchers, undefined, tallyPL);

  // Monthly profit breakdown
  const monthlyIncome: Record<string, number> = {};
  const monthlyExpense: Record<string, number> = {};

  for (const v of vouchers) {
    if (v.isCancelled || v.isOptional) continue;
    // Skip non-operational vouchers (Journal/Contra are balance adjustments)
    if (["Journal", "Contra", "Stock Journal"].includes(v.voucherType)) continue;
    const ym = v.date.slice(0, 7);
    // DN/CN sign reversal
    const isReturn = v.voucherType === "Credit Note" || v.voucherType === "Debit Note";
    const sign = isReturn ? -1 : 1;

    for (const line of v.lines) {
      if (line.type !== "ledger" || !line.ledgerId) continue;
      const ledger = ledgers.get(line.ledgerId);
      if (!ledger) continue;
      const cat = classifyLedgerGroup(ledger.group);
      const amt = line.amount ?? 0;

      // Revenue: credit to income = income; debit to income = contra-income (e.g. Trade Discounts)
      if (cat === "income") {
        const rev = (line.isDebit ? -amt : amt) * sign;
        monthlyIncome[ym] = (monthlyIncome[ym] ?? 0) + rev;
      }
      // Expense: debit to expense = expense; credit to expense = contra-expense
      if (cat === "expense") {
        const exp = (line.isDebit ? amt : -amt) * sign;
        monthlyExpense[ym] = (monthlyExpense[ym] ?? 0) + exp;
      }
    }
  }

  // Build monthly profit trend
  const allMonths = new Set([...Object.keys(monthlyIncome), ...Object.keys(monthlyExpense)]);
  const sortedMonths = Array.from(allMonths).sort();

  let cumulative = 0;
  const monthlyProfitTrend = sortedMonths.map(m => {
    const profit = (monthlyIncome[m] ?? 0) - (monthlyExpense[m] ?? 0);
    cumulative += profit;
    return { month: m, profit, cumulative };
  });

  // Annualized profit estimation
  const monthsElapsed = sortedMonths.length || 1;
  const annualizedProfit = monthsElapsed >= 12 ? pl.netProfit : (pl.netProfit / monthsElapsed) * 12;
  const taxableIncome = Math.max(annualizedProfit, 0);

  // Tax computation
  const basicTax = taxableIncome * (regime.rate / 100);
  const surcharge = basicTax * (regime.surchargeRate / 100);
  const taxPlusSurcharge = basicTax + surcharge;
  const cess = taxPlusSurcharge * (regime.cessRate / 100);
  const totalTax = taxPlusSurcharge + cess;

  // Quarterly installments
  const quarterDefs = [
    { quarter: "Q1", label: "Apr-Jun", dueDate: "Jun 15", cumulativePct: 15, installmentPct: 15 },
    { quarter: "Q2", label: "Jul-Sep", dueDate: "Sep 15", cumulativePct: 45, installmentPct: 30 },
    { quarter: "Q3", label: "Oct-Dec", dueDate: "Dec 15", cumulativePct: 75, installmentPct: 30 },
    { quarter: "Q4", label: "Jan-Mar", dueDate: "Mar 15", cumulativePct: 100, installmentPct: 25 },
  ];

  // Determine FY year from data
  let fyYear = "2025-26";
  if (sortedMonths.length > 0) {
    const firstMonth = sortedMonths[0];
    const [y, m] = firstMonth.split("-").map(Number);
    const startYear = m >= fyStartMonth ? y : y - 1;
    fyYear = `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
  }

  // Compute profit to date for each quarter end
  const startYear = parseInt(fyYear.split("-")[0], 10);
  const quarterEndMonths = [
    `${startYear}-06`, // Q1 ends June
    `${startYear}-09`, // Q2 ends September
    `${startYear}-12`, // Q3 ends December
    `${startYear + 1}-03`, // Q4 ends March
  ];

  const quarters: QuarterlyInstallment[] = quarterDefs.map((qd, i) => {
    const endMonth = quarterEndMonths[i];
    const profitToDate = monthlyProfitTrend
      .filter(m => m.month <= endMonth)
      .reduce((s, m) => s + m.profit, 0);

    return {
      ...qd,
      cumulativeAmount: totalTax * (qd.cumulativePct / 100),
      installmentAmount: totalTax * (qd.installmentPct / 100),
      profitToDate,
    };
  });

  return {
    regime,
    fyYear,
    annualProfit: pl.netProfit,
    annualTurnover: pl.totalIncome,
    taxableIncome,
    basicTax,
    surcharge,
    cess,
    totalTax,
    quarters,
    monthlyProfitTrend,
  };
}
