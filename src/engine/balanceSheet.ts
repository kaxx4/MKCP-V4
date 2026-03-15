import type { CanonicalLedger, CanonicalVoucher, CanonicalItem } from "../types/canonical";

// ─── Tally Standard Group Classification ────────────────────────────────

const ASSET_GROUPS = [
  "bank accounts", "bank occ a/c", "bank od a/c",
  "cash-in-hand", "cash-in hand",
  "sundry debtors", "debtors",
  "stock-in-hand", "stock in hand",
  "fixed assets",
  "investments",
  "deposits (asset)", "deposits",
  "loans & advances (asset)", "loans and advances (asset)",
  "current assets",
];

const LIABILITY_GROUPS = [
  "sundry creditors", "creditors",
  "duties & taxes", "duties and taxes",
  "provisions",
  "secured loans", "unsecured loans",
  "bank od a/c",
  "current liabilities",
  "loans (liability)", "loans and advances (liability)",
];

const CAPITAL_GROUPS = [
  "capital account",
  "reserves & surplus", "reserves and surplus",
  "retained earnings",
];

const INCOME_GROUPS = [
  "sales accounts", "sales account",
  "direct income", "direct incomes",
  "indirect income", "indirect incomes",
];

const EXPENSE_GROUPS = [
  "purchase accounts", "purchase account",
  "direct expenses", "direct expense",
  "indirect expenses", "indirect expense",
  "manufacturing expenses",
];

export type BSCategory = "asset" | "liability" | "capital" | "income" | "expense" | "unknown";

export function classifyLedgerGroup(group: string): BSCategory {
  const g = group.toLowerCase().trim();
  if (ASSET_GROUPS.some(a => g.includes(a))) return "asset";
  if (LIABILITY_GROUPS.some(l => g.includes(l))) return "liability";
  if (CAPITAL_GROUPS.some(c => g.includes(c))) return "capital";
  if (INCOME_GROUPS.some(i => g.includes(i))) return "income";
  if (EXPENSE_GROUPS.some(e => g.includes(e))) return "expense";
  // Fallback heuristics
  if (g.includes("bank") || g.includes("cash") || g.includes("debtor")) return "asset";
  if (g.includes("creditor") || g.includes("tax") || g.includes("loan")) return "liability";
  if (g.includes("capital") || g.includes("reserve")) return "capital";
  if (g.includes("income") || g.includes("sale") || g.includes("revenue")) return "income";
  if (g.includes("expense") || g.includes("purchase") || g.includes("cost")) return "expense";
  return "unknown";
}

// ─── Trial Balance ──────────────────────────────────────────────────────

export interface TrialBalanceEntry {
  ledgerId: string;
  name: string;
  group: string;
  category: BSCategory;
  openingBalance: number;   // +Dr, -Cr
  totalDebit: number;
  totalCredit: number;
  closingBalance: number;   // +Dr, -Cr
}

export function computeTrialBalance(
  ledgers: Map<string, CanonicalLedger>,
  vouchers: CanonicalVoucher[]
): TrialBalanceEntry[] {
  // Accumulate debit/credit per ledger from vouchers
  const debitMap = new Map<string, number>();
  const creditMap = new Map<string, number>();

  for (const v of vouchers) {
    if (v.isCancelled || v.isOptional) continue;
    for (const line of v.lines) {
      if (line.type !== "ledger" || !line.ledgerId) continue;
      const amt = Math.abs(line.amount ?? 0);
      if (line.isDebit) {
        debitMap.set(line.ledgerId, (debitMap.get(line.ledgerId) ?? 0) + amt);
      } else {
        creditMap.set(line.ledgerId, (creditMap.get(line.ledgerId) ?? 0) + amt);
      }
    }
  }

  const entries: TrialBalanceEntry[] = [];
  for (const [, ledger] of ledgers) {
    const totalDebit = debitMap.get(ledger.ledgerId) ?? 0;
    const totalCredit = creditMap.get(ledger.ledgerId) ?? 0;
    // Tally stores openingBalance in credit-positive convention (negative=Dr, positive=Cr)
    // Convert to debit-positive (+Dr, -Cr) by negating, then apply debits/credits
    const obDebitPositive = -ledger.openingBalance;
    const closingBalance = obDebitPositive + totalDebit - totalCredit;

    entries.push({
      ledgerId: ledger.ledgerId,
      name: ledger.name,
      group: ledger.group,
      category: classifyLedgerGroup(ledger.group),
      openingBalance: obDebitPositive,
      totalDebit,
      totalCredit,
      closingBalance,
    });
  }

  return entries;
}

// ─── Balance Sheet ──────────────────────────────────────────────────────

export interface BSGroupTotal {
  group: string;
  category: BSCategory;
  total: number;          // closing balance sum
  ledgers: TrialBalanceEntry[];
}

export interface BalanceSheetData {
  assets: BSGroupTotal[];
  liabilities: BSGroupTotal[];
  capital: BSGroupTotal[];
  totalAssets: number;
  totalLiabilities: number;
  totalCapital: number;
  netProfit: number;       // from P&L
  totalLiabilitiesAndCapital: number;
  stockValue: number;      // from stock items
}

export function computeBalanceSheet(
  ledgers: Map<string, CanonicalLedger>,
  vouchers: CanonicalVoucher[],
  items?: Map<string, CanonicalItem>
): BalanceSheetData {
  const tb = computeTrialBalance(ledgers, vouchers);

  // Group by category and ledger group
  const groupMap = new Map<string, BSGroupTotal>();

  for (const entry of tb) {
    const key = entry.group;
    let g = groupMap.get(key);
    if (!g) {
      g = { group: entry.group, category: entry.category, total: 0, ledgers: [] };
      groupMap.set(key, g);
    }
    g.total += entry.closingBalance;
    g.ledgers.push(entry);
  }

  const groups = Array.from(groupMap.values());
  const assets = groups.filter(g => g.category === "asset").sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
  const liabilities = groups.filter(g => g.category === "liability").sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
  const capital = groups.filter(g => g.category === "capital").sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
  const incomeGroups = groups.filter(g => g.category === "income");
  const expenseGroups = groups.filter(g => g.category === "expense");

  // Compute P&L (with stock adjustment matching Tally)
  const totalIncome = incomeGroups.reduce((s, g) => s + Math.abs(g.total), 0);
  const totalExpenses = expenseGroups.reduce((s, g) => s + Math.abs(g.total), 0);

  // Stock value from items
  let stockValue = 0;
  let openingStockValue = 0;
  if (items) {
    for (const [, item] of items) {
      stockValue += item.closingValue ?? item.openingValue;
      openingStockValue += item.openingValue;
    }
  }
  // Stock adjustment = Opening Stock - Closing Stock (added to COGS)
  const stockAdjustment = openingStockValue - stockValue;
  const netProfit = totalIncome - totalExpenses - stockAdjustment;

  const totalAssets = assets.reduce((s, g) => s + g.total, 0) + stockValue;
  const totalLiabilities = Math.abs(liabilities.reduce((s, g) => s + g.total, 0));
  const totalCapital = Math.abs(capital.reduce((s, g) => s + g.total, 0));

  return {
    assets,
    liabilities,
    capital,
    totalAssets,
    totalLiabilities,
    totalCapital,
    netProfit,
    totalLiabilitiesAndCapital: totalLiabilities + totalCapital + netProfit,
    stockValue,
  };
}

// ─── Profit & Loss ──────────────────────────────────────────────────────

export interface PLGroupTotal {
  group: string;
  total: number;
  ledgers: { name: string; amount: number }[];
}

export interface ProfitAndLossData {
  income: PLGroupTotal[];
  expenses: PLGroupTotal[];
  totalIncome: number;
  totalExpenses: number;
  grossProfit: number;
  netProfit: number;
  directIncome: number;
  directExpenses: number;
  indirectIncome: number;
  indirectExpenses: number;
  openingStock: number;
  closingStock: number;
  stockAdjustment: number;  // openingStock - closingStock (added to COGS)
}

export function computeProfitAndLoss(
  ledgers: Map<string, CanonicalLedger>,
  vouchers: CanonicalVoucher[],
  items?: Map<string, CanonicalItem>
): ProfitAndLossData {
  const tb = computeTrialBalance(ledgers, vouchers);

  const incomeMap = new Map<string, PLGroupTotal>();
  const expenseMap = new Map<string, PLGroupTotal>();

  for (const entry of tb) {
    if (entry.category === "income") {
      let g = incomeMap.get(entry.group);
      if (!g) { g = { group: entry.group, total: 0, ledgers: [] }; incomeMap.set(entry.group, g); }
      // Income ledgers: credit balance (negative closingBalance) = income
      // Contra-income (e.g. Trade Discounts): debit balance (positive) = reduces income
      const amt = -entry.closingBalance; // credit(-) → positive income; debit(+) → negative (reduces)
      g.total += amt;
      g.ledgers.push({ name: entry.name, amount: amt });
    } else if (entry.category === "expense") {
      let g = expenseMap.get(entry.group);
      if (!g) { g = { group: entry.group, total: 0, ledgers: [] }; expenseMap.set(entry.group, g); }
      // Expense ledgers: debit balance (positive closingBalance) = expense
      // Contra-expense: credit balance (negative) = reduces expense
      const amt = entry.closingBalance; // debit(+) → positive expense; credit(-) → negative (reduces)
      g.total += amt;
      g.ledgers.push({ name: entry.name, amount: amt });
    }
  }

  const income = Array.from(incomeMap.values()).sort((a, b) => b.total - a.total);
  const expenses = Array.from(expenseMap.values()).sort((a, b) => b.total - a.total);

  const totalIncome = income.reduce((s, g) => s + g.total, 0);
  const totalExpenses = expenses.reduce((s, g) => s + g.total, 0);

  const directIncomeGroups = ["sales accounts", "sales account", "direct income", "direct incomes"];
  const directExpenseGroups = ["purchase accounts", "purchase account", "direct expenses", "direct expense", "manufacturing expenses"];

  // Use startsWith to avoid "indirect incomes".includes("direct incomes") false positive
  const isDirectIncome = (group: string) => {
    const g = group.toLowerCase();
    if (g.includes("indirect")) return false;
    return directIncomeGroups.some(d => g.includes(d));
  };
  const isDirectExpense = (group: string) => {
    const g = group.toLowerCase();
    if (g.includes("indirect")) return false;
    return directExpenseGroups.some(d => g.includes(d));
  };

  const directIncome = income.filter(g => isDirectIncome(g.group)).reduce((s, g) => s + g.total, 0);
  const directExpenses = expenses.filter(g => isDirectExpense(g.group)).reduce((s, g) => s + g.total, 0);

  // Stock valuation adjustment (Tally P&L includes Opening/Closing Stock)
  // Opening Stock - Closing Stock is added to COGS (cost side)
  let openingStock = 0;
  let closingStock = 0;
  if (items) {
    for (const [, item] of items) {
      openingStock += item.openingValue;
      closingStock += item.closingValue ?? item.openingValue;
    }
  }
  const stockAdjustment = openingStock - closingStock; // positive = stock decreased = adds to cost

  // Gross Profit = Direct Income + Closing Stock - Opening Stock - Direct Expenses
  // = Direct Income - Direct Expenses - stockAdjustment
  const grossProfit = directIncome - directExpenses - stockAdjustment;

  // Net Profit = Total Income - Total Expenses - Stock Adjustment
  const netProfit = totalIncome - totalExpenses - stockAdjustment;

  return {
    income,
    expenses,
    totalIncome,
    totalExpenses,
    grossProfit,
    netProfit,
    directIncome,
    directExpenses,
    indirectIncome: totalIncome - directIncome,
    indirectExpenses: totalExpenses - directExpenses,
    openingStock,
    closingStock,
    stockAdjustment,
  };
}
