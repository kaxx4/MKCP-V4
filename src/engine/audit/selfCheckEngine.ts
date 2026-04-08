import type { CanonicalVoucher, CanonicalLedger, CanonicalItem } from "../../types/canonical";
import { classifyLedgerGroup } from "../balanceSheet";
import { getCurrentStockIndexed, type VoucherIndex } from "../inventory";

// ─── Types ──────────────────────────────────────────────────────────

export type CheckSeverity = "OK" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface CheckResult {
  check: string;
  category: "stock" | "ledger" | "voucher" | "tax" | "order" | "valuation";
  severity: CheckSeverity;
  message: string;
  expected?: number;
  actual?: number;
  delta?: number;
  details?: VoucherMismatch[] | LedgerMismatch[] | StockMismatch[];
}

export interface VoucherMismatch {
  voucherId: string;
  voucherNumber: string;
  voucherType: string;
  date: string;
  totalDebit: number;
  totalCredit: number;
  delta: number;
}

export interface LedgerMismatch {
  ledgerId: string;
  name: string;
  group: string;
  expected: number;
  actual: number;
  delta: number;
}

export interface StockMismatch {
  itemId: string;
  name: string;
  opening: number;
  inwards: number;
  outwards: number;
  expectedClosing: number;
  actualClosing: number;
  delta: number;
}

export interface SelfCheckReport {
  timestamp: string;
  totalChecks: number;
  passed: number;
  warnings: number;
  failures: number;
  critical: number;
  results: CheckResult[];
}

// ─── Main Entry Point ───────────────────────────────────────────────

export function runSelfCheck(
  vouchers: CanonicalVoucher[],
  ledgers: Map<string, CanonicalLedger>,
  items: Map<string, CanonicalItem>,
  voucherIndex: VoucherIndex,
): SelfCheckReport {
  const results: CheckResult[] = [];

  results.push(...checkVoucherBalance(vouchers));
  results.push(...checkStockMath(items, vouchers, voucherIndex));
  results.push(...checkLedgerReconciliation(vouchers, ledgers));
  results.push(...checkVoucherTotals(vouchers));
  results.push(...checkRevenueExpenseConsistency(vouchers, ledgers));
  results.push(...checkStockValuation(items));

  const passed = results.filter(r => r.severity === "OK").length;
  const warnings = results.filter(r => r.severity === "LOW" || r.severity === "MEDIUM").length;
  const failures = results.filter(r => r.severity === "HIGH").length;
  const critical = results.filter(r => r.severity === "CRITICAL").length;

  return {
    timestamp: new Date().toISOString(),
    totalChecks: results.length,
    passed,
    warnings,
    failures,
    critical,
    results,
  };
}

// ─── Check 1: Voucher Debit/Credit Balance ──────────────────────────

function checkVoucherBalance(vouchers: CanonicalVoucher[]): CheckResult[] {
  const mismatches: VoucherMismatch[] = [];

  for (const v of vouchers) {
    if (v.isCancelled || v.isOptional) continue;

    let totalDebit = 0;
    let totalCredit = 0;

    for (const line of v.lines) {
      if (line.type !== "ledger") continue;
      const amt = line.amount ?? 0;
      if (line.isDebit) totalDebit += amt;
      else totalCredit += amt;
    }

    const delta = Math.abs(totalDebit - totalCredit);
    // Allow small rounding tolerance (₹1)
    if (delta > 1) {
      mismatches.push({
        voucherId: v.voucherId,
        voucherNumber: v.voucherNumber,
        voucherType: v.voucherType,
        date: v.date,
        totalDebit,
        totalCredit,
        delta,
      });
    }
  }

  const severity: CheckSeverity = mismatches.length === 0 ? "OK"
    : mismatches.length > 50 ? "CRITICAL"
    : mismatches.length > 10 ? "HIGH"
    : "MEDIUM";

  return [{
    check: "Voucher Debit/Credit Balance",
    category: "voucher",
    severity,
    message: mismatches.length === 0
      ? "All vouchers balance (debit = credit)"
      : `${mismatches.length} vouchers have debit/credit imbalance`,
    expected: 0,
    actual: mismatches.length,
    delta: mismatches.reduce((s, m) => s + m.delta, 0),
    details: mismatches.slice(0, 50) as VoucherMismatch[],
  }];
}

// ─── Check 2: Stock Math (closing = opening + inwards - outwards) ───

function checkStockMath(
  items: Map<string, CanonicalItem>,
  vouchers: CanonicalVoucher[],
  voucherIndex: VoucherIndex,
): CheckResult[] {
  const mismatches: StockMismatch[] = [];

  // Accumulate inwards/outwards per item in a single pass
  const itemInwards = new Map<string, number>();
  const itemOutwards = new Map<string, number>();

  for (const v of vouchers) {
    if (v.isCancelled || v.isOptional) continue;
    for (const line of v.lines) {
      if (line.type !== "inventory" || !line.itemId) continue;
      const qty = line.qtyBase ?? 0;

      if (v.voucherType === "Purchase" || v.voucherType === "Credit Note") {
        itemInwards.set(line.itemId, (itemInwards.get(line.itemId) ?? 0) + qty);
      } else if (v.voucherType === "Sales" || v.voucherType === "Debit Note") {
        itemOutwards.set(line.itemId, (itemOutwards.get(line.itemId) ?? 0) + qty);
      } else if (v.voucherType === "Stock Journal") {
        if (qty > 0) itemInwards.set(line.itemId, (itemInwards.get(line.itemId) ?? 0) + qty);
        else itemOutwards.set(line.itemId, (itemOutwards.get(line.itemId) ?? 0) + Math.abs(qty));
      }
    }
  }

  for (const [, item] of items) {
    const inwards = itemInwards.get(item.itemId) ?? 0;
    const outwards = itemOutwards.get(item.itemId) ?? 0;
    const expectedClosing = item.openingQtyBase + inwards - outwards;
    const actualClosing = getCurrentStockIndexed(item, voucherIndex);
    const delta = Math.abs(expectedClosing - actualClosing);

    if (delta > 0.01) {
      mismatches.push({
        itemId: item.itemId,
        name: item.name,
        opening: item.openingQtyBase,
        inwards,
        outwards,
        expectedClosing,
        actualClosing,
        delta,
      });
    }
  }

  const severity: CheckSeverity = mismatches.length === 0 ? "OK"
    : mismatches.length > 20 ? "HIGH"
    : "MEDIUM";

  return [{
    check: "Stock Math (closing = opening + in - out)",
    category: "stock",
    severity,
    message: mismatches.length === 0
      ? "All items: closing stock matches opening + inwards - outwards"
      : `${mismatches.length} items have stock math discrepancy`,
    expected: 0,
    actual: mismatches.length,
    details: mismatches.slice(0, 50) as StockMismatch[],
  }];
}

// ─── Check 3: Ledger Reconciliation ─────────────────────────────────

function checkLedgerReconciliation(
  vouchers: CanonicalVoucher[],
  ledgers: Map<string, CanonicalLedger>,
): CheckResult[] {
  // Verify total debits = total credits across all vouchers (double-entry)
  let grandDebit = 0;
  let grandCredit = 0;

  for (const v of vouchers) {
    if (v.isCancelled || v.isOptional) continue;
    for (const line of v.lines) {
      if (line.type !== "ledger") continue;
      const amt = line.amount ?? 0;
      if (line.isDebit) grandDebit += amt;
      else grandCredit += amt;
    }
  }

  const delta = Math.abs(grandDebit - grandCredit);
  const severity: CheckSeverity = delta < 1 ? "OK"
    : delta < 10000 ? "MEDIUM"
    : "HIGH";

  const results: CheckResult[] = [{
    check: "Grand Ledger Balance (Total Debits = Total Credits)",
    category: "ledger",
    severity,
    message: delta < 1
      ? `Grand totals balance: ₹${grandDebit.toFixed(2)} Dr = ₹${grandCredit.toFixed(2)} Cr`
      : `Grand imbalance: Dr ₹${grandDebit.toFixed(2)} vs Cr ₹${grandCredit.toFixed(2)} (Δ₹${delta.toFixed(2)})`,
    expected: grandDebit,
    actual: grandCredit,
    delta,
  }];

  // Check for orphan ledger references (voucher line references unknown ledger)
  const orphanLedgers = new Set<string>();
  for (const v of vouchers) {
    if (v.isCancelled) continue;
    for (const line of v.lines) {
      if (line.type === "ledger" && line.ledgerId && !ledgers.has(line.ledgerId)) {
        orphanLedgers.add(line.ledgerId);
      }
    }
  }

  results.push({
    check: "Orphan Ledger References",
    category: "ledger",
    severity: orphanLedgers.size === 0 ? "OK" : orphanLedgers.size > 10 ? "HIGH" : "MEDIUM",
    message: orphanLedgers.size === 0
      ? "All voucher ledger references resolve to known ledgers"
      : `${orphanLedgers.size} ledger IDs referenced in vouchers but not found in master data`,
    expected: 0,
    actual: orphanLedgers.size,
  });

  return results;
}

// ─── Check 4: Voucher Type Totals ───────────────────────────────────

function checkVoucherTotals(vouchers: CanonicalVoucher[]): CheckResult[] {
  const typeCounts: Record<string, number> = {};
  let cancelledCount = 0;
  let zeroAmountCount = 0;
  let noLinesCount = 0;

  for (const v of vouchers) {
    typeCounts[v.voucherType] = (typeCounts[v.voucherType] ?? 0) + 1;
    if (v.isCancelled) cancelledCount++;
    if (v.totalAmount === 0 && !v.isCancelled) zeroAmountCount++;
    if (v.lines.length === 0 && !v.isCancelled) noLinesCount++;
  }

  const results: CheckResult[] = [{
    check: "Voucher Type Distribution",
    category: "voucher",
    severity: "OK",
    message: Object.entries(typeCounts)
      .sort(([, a], [, b]) => b - a)
      .map(([t, c]) => `${t}: ${c}`)
      .join(", "),
    actual: vouchers.length,
  }];

  if (zeroAmountCount > 0) {
    results.push({
      check: "Zero-Amount Vouchers",
      category: "voucher",
      severity: zeroAmountCount > 50 ? "MEDIUM" : "LOW",
      message: `${zeroAmountCount} non-cancelled vouchers have zero totalAmount`,
      actual: zeroAmountCount,
    });
  }

  if (noLinesCount > 0) {
    results.push({
      check: "Empty Vouchers (No Lines)",
      category: "voucher",
      severity: noLinesCount > 10 ? "HIGH" : "MEDIUM",
      message: `${noLinesCount} non-cancelled vouchers have no ledger/inventory lines`,
      actual: noLinesCount,
    });
  }

  return results;
}

// ─── Check 5: Revenue vs Expense Consistency ────────────────────────

function checkRevenueExpenseConsistency(
  vouchers: CanonicalVoucher[],
  ledgers: Map<string, CanonicalLedger>,
): CheckResult[] {
  // Compare Sales voucher totalAmount sum vs income ledger credits
  let salesVoucherTotal = 0;
  let purchaseVoucherTotal = 0;
  let incomeCredit = 0;
  let expenseDebit = 0;

  for (const v of vouchers) {
    if (v.isCancelled || v.isOptional) continue;
    if (v.voucherType === "Sales") salesVoucherTotal += v.totalAmount;
    if (v.voucherType === "Purchase") purchaseVoucherTotal += v.totalAmount;

    for (const line of v.lines) {
      if (line.type !== "ledger" || !line.ledgerId) continue;
      const ledger = ledgers.get(line.ledgerId);
      if (!ledger) continue;
      const cat = classifyLedgerGroup(ledger.group);
      const amt = line.amount ?? 0;

      if (cat === "income" && !line.isDebit) incomeCredit += amt;
      if (cat === "expense" && line.isDebit) expenseDebit += amt;
    }
  }

  const results: CheckResult[] = [];

  // Sales voucher total vs income ledger credits (rough match — won't be exact due to party lines, tax lines etc.)
  const salesDelta = Math.abs(salesVoucherTotal - incomeCredit);
  const salesPctDiff = incomeCredit > 0 ? (salesDelta / incomeCredit) * 100 : 0;
  results.push({
    check: "Sales Total vs Income Credits",
    category: "ledger",
    severity: salesPctDiff < 5 ? "OK" : salesPctDiff < 15 ? "MEDIUM" : "HIGH",
    message: `Sales vouchers total: ₹${(salesVoucherTotal / 100000).toFixed(1)}L, Income credits: ₹${(incomeCredit / 100000).toFixed(1)}L (Δ${salesPctDiff.toFixed(1)}%)`,
    expected: salesVoucherTotal,
    actual: incomeCredit,
    delta: salesDelta,
  });

  const purchaseDelta = Math.abs(purchaseVoucherTotal - expenseDebit);
  const purchasePctDiff = expenseDebit > 0 ? (purchaseDelta / expenseDebit) * 100 : 0;
  results.push({
    check: "Purchase Total vs Expense Debits",
    category: "ledger",
    severity: purchasePctDiff < 5 ? "OK" : purchasePctDiff < 15 ? "MEDIUM" : "HIGH",
    message: `Purchase vouchers total: ₹${(purchaseVoucherTotal / 100000).toFixed(1)}L, Expense debits: ₹${(expenseDebit / 100000).toFixed(1)}L (Δ${purchasePctDiff.toFixed(1)}%)`,
    expected: purchaseVoucherTotal,
    actual: expenseDebit,
    delta: purchaseDelta,
  });

  return results;
}

// ─── Check 6: Stock Valuation ───────────────────────────────────────

function checkStockValuation(items: Map<string, CanonicalItem>): CheckResult[] {
  let totalOpening = 0;
  let totalClosing = 0;
  let negativeClosingCount = 0;
  let missingClosingCount = 0;

  for (const [, item] of items) {
    totalOpening += item.openingValue;
    const cv = item.closingValue ?? item.openingValue;
    totalClosing += cv;
    if (cv < 0) negativeClosingCount++;
    if (item.closingValue === undefined) missingClosingCount++;
  }

  const results: CheckResult[] = [{
    check: "Total Stock Valuation",
    category: "valuation",
    severity: "OK",
    message: `Opening: ₹${(totalOpening / 100000).toFixed(1)}L, Closing: ₹${(totalClosing / 100000).toFixed(1)}L, Adjustment: ₹${((totalOpening - totalClosing) / 100000).toFixed(1)}L`,
    expected: totalOpening,
    actual: totalClosing,
    delta: totalOpening - totalClosing,
  }];

  if (negativeClosingCount > 0) {
    results.push({
      check: "Negative Closing Values",
      category: "valuation",
      severity: negativeClosingCount > 10 ? "HIGH" : "MEDIUM",
      message: `${negativeClosingCount} items have negative closing value`,
      actual: negativeClosingCount,
    });
  }

  if (missingClosingCount > 0) {
    results.push({
      check: "Missing Closing Values (fallback to opening)",
      category: "valuation",
      severity: missingClosingCount > items.size * 0.1 ? "HIGH" : "LOW",
      message: `${missingClosingCount} of ${items.size} items have no closing value — using opening value as fallback`,
      actual: missingClosingCount,
    });
  }

  return results;
}
