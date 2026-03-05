/**
 * Audit & Validation Engine
 *
 * Cross-verifies every inventory number against the identity:
 *   CLOSING = OPENING + INWARDS - OUTWARDS
 *
 * Every item must have discrepancy === 0. If not, there's a bug.
 */

import type {
  CanonicalVoucher,
  CanonicalItem,
  CanonicalLedger,
} from "../types/canonical";
import type { VoucherIndex } from "./inventory";
import { getCurrentStockIndexed, computeMonthlyBucketsIndexed } from "./inventory";

const EPSILON = 1e-9;

export interface AuditResult {
  itemId: string;
  itemName: string;
  openingQtyBase: number;
  totalInwards: number;
  totalOutwards: number;
  expectedClosing: number;
  computedClosing: number;
  discrepancy: number;
  monthlyChainValid: boolean;
  details: {
    purchaseQty: number;
    salesQty: number;
    creditNoteQty: number;
    debitNoteQty: number;
    stockJournalInQty: number;
    stockJournalOutQty: number;
    voucherCount: number;
    cancelledSkipped: number;
    optionalSkipped: number;
  };
}

export interface MonthlyChainBreak {
  month: string;
  expectedOpening: number;
  actualOpening: number;
}

export interface MonthlyChainResult {
  valid: boolean;
  breaks: MonthlyChainBreak[];
}

export interface InvoiceBalanceResult {
  totalBilled: number;
  totalPaid: number;
  totalOutstanding: number;
  orphanedPayments: string[];
}

/**
 * Audit all items — single pass over vouchers.
 * Verifies that opening + inwards - outwards === getCurrentStockIndexed for every item.
 */
export function auditAllItems(
  items: Map<string, CanonicalItem>,
  vouchers: CanonicalVoucher[],
  voucherIndex: VoucherIndex
): AuditResult[] {
  // Accumulate per-item quantities in a single pass over all vouchers
  interface ItemAcc {
    purchaseQty: number;
    salesQty: number;
    creditNoteQty: number;
    debitNoteQty: number;
    stockJournalInQty: number;
    stockJournalOutQty: number;
    voucherCount: number;
    cancelledSkipped: number;
    optionalSkipped: number;
  }

  const accMap = new Map<string, ItemAcc>();

  function getAcc(itemId: string): ItemAcc {
    let a = accMap.get(itemId);
    if (!a) {
      a = {
        purchaseQty: 0,
        salesQty: 0,
        creditNoteQty: 0,
        debitNoteQty: 0,
        stockJournalInQty: 0,
        stockJournalOutQty: 0,
        voucherCount: 0,
        cancelledSkipped: 0,
        optionalSkipped: 0,
      };
      accMap.set(itemId, a);
    }
    return a;
  }

  // Single pass over all vouchers
  for (const v of vouchers) {
    for (const line of v.lines) {
      if (line.type !== "inventory" || !line.itemId) continue;
      const a = getAcc(line.itemId);

      if (v.isCancelled) {
        a.cancelledSkipped++;
        continue;
      }
      if (v.isOptional) {
        a.optionalSkipped++;
        continue;
      }

      a.voucherCount++;
      const qty = line.qtyBase ?? 0;

      switch (v.voucherType) {
        case "Purchase":
          a.purchaseQty += qty;
          break;
        case "Sales":
          a.salesQty += qty;
          break;
        case "Credit Note":
          a.creditNoteQty += qty;
          break;
        case "Debit Note":
          a.debitNoteQty += qty;
          break;
        case "Stock Journal":
          if (qty > 0) a.stockJournalInQty += qty;
          else a.stockJournalOutQty += Math.abs(qty);
          break;
      }
    }
  }

  // Build results for every item
  const results: AuditResult[] = [];

  for (const [itemId, item] of items) {
    const a = accMap.get(itemId) ?? {
      purchaseQty: 0,
      salesQty: 0,
      creditNoteQty: 0,
      debitNoteQty: 0,
      stockJournalInQty: 0,
      stockJournalOutQty: 0,
      voucherCount: 0,
      cancelledSkipped: 0,
      optionalSkipped: 0,
    };

    const totalInwards = a.purchaseQty + a.creditNoteQty + a.stockJournalInQty;
    const totalOutwards = a.salesQty + a.debitNoteQty + a.stockJournalOutQty;
    const expectedClosing = item.openingQtyBase + totalInwards - totalOutwards;
    const computedClosing = getCurrentStockIndexed(item, voucherIndex);
    const discrepancy = expectedClosing - computedClosing;

    // Check monthly chain validity
    const chainResult = auditMonthlyChain(item, voucherIndex, 24);

    results.push({
      itemId,
      itemName: item.name,
      openingQtyBase: item.openingQtyBase,
      totalInwards,
      totalOutwards,
      expectedClosing,
      computedClosing,
      discrepancy,
      monthlyChainValid: chainResult.valid,
      details: a,
    });
  }

  return results;
}

/**
 * Verify the monthly chain for a single item:
 * For every consecutive month pair, closing[i] === opening[i+1]
 */
export function auditMonthlyChain(
  item: CanonicalItem,
  voucherIndex: VoucherIndex,
  nMonths: number = 12
): MonthlyChainResult {
  const buckets = computeMonthlyBucketsIndexed(item, voucherIndex, nMonths);
  const breaks: MonthlyChainBreak[] = [];

  for (let i = 0; i < buckets.length - 1; i++) {
    const currentClosing = buckets[i].closingQtyBase;
    const nextOpening = buckets[i + 1].openingQtyBase;
    if (Math.abs(currentClosing - nextOpening) > EPSILON) {
      breaks.push({
        month: buckets[i + 1].yearMonth,
        expectedOpening: currentClosing,
        actualOpening: nextOpening,
      });
    }
  }

  return { valid: breaks.length === 0, breaks };
}

/**
 * Audit invoice balance: total billed vs total paid vs outstanding.
 * Also finds orphaned payments (payments against non-existent invoices).
 */
export function auditInvoiceBalance(
  vouchers: CanonicalVoucher[],
  _ledgers: Map<string, CanonicalLedger>
): InvoiceBalanceResult {
  // Build bill reference -> billed amount map from Sales/Purchase vouchers
  const billedAmounts = new Map<string, number>();
  const paidAmounts = new Map<string, number>();

  for (const v of vouchers) {
    if (v.isCancelled || v.isOptional) continue;

    if (v.voucherType === "Sales" || v.voucherType === "Purchase") {
      // Use bill allocation "New Ref" amount if available, else totalAmount
      let billedAmount = v.totalAmount;
      for (const line of v.lines) {
        if (!line.isPartyLine) continue;
        for (const ba of line.billAllocations ?? []) {
          if (ba.billType === "New Ref") {
            billedAmount = ba.amount;
          }
        }
      }
      billedAmounts.set(v.voucherNumber, billedAmount);
    }

    if (v.voucherType === "Receipt" || v.voucherType === "Payment") {
      for (const line of v.lines) {
        if (line.type !== "ledger") continue;
        for (const ba of line.billAllocations ?? []) {
          if (ba.billType === "Agst Ref") {
            paidAmounts.set(
              ba.billRef,
              (paidAmounts.get(ba.billRef) ?? 0) + ba.amount
            );
          }
        }
      }
    }
  }

  let totalBilled = 0;
  let totalPaid = 0;

  for (const [, amt] of billedAmounts) {
    totalBilled += amt;
  }

  // Find orphaned payments (payments for invoices that don't exist in our data)
  const orphanedPayments: string[] = [];
  for (const [billRef, amt] of paidAmounts) {
    totalPaid += amt;
    if (!billedAmounts.has(billRef)) {
      orphanedPayments.push(billRef);
    }
  }

  return {
    totalBilled,
    totalPaid,
    totalOutstanding: totalBilled - totalPaid,
    orphanedPayments,
  };
}

/**
 * Get voucher type distribution from all vouchers.
 */
export function getVoucherTypeDistribution(
  vouchers: CanonicalVoucher[]
): Map<string, { total: number; cancelled: number; optional: number; active: number }> {
  const dist = new Map<string, { total: number; cancelled: number; optional: number; active: number }>();

  for (const v of vouchers) {
    let entry = dist.get(v.voucherType);
    if (!entry) {
      entry = { total: 0, cancelled: 0, optional: 0, active: 0 };
      dist.set(v.voucherType, entry);
    }
    entry.total++;
    if (v.isCancelled) entry.cancelled++;
    else if (v.isOptional) entry.optional++;
    else entry.active++;
  }

  return dist;
}

/**
 * Find items with negative stock (possible data issues).
 */
export function findNegativeStockItems(
  items: Map<string, CanonicalItem>,
  voucherIndex: VoucherIndex
): Array<{ itemId: string; name: string; currentStock: number }> {
  const results: Array<{ itemId: string; name: string; currentStock: number }> = [];

  for (const [, item] of items) {
    const stock = getCurrentStockIndexed(item, voucherIndex);
    if (stock < -EPSILON) {
      results.push({ itemId: item.itemId, name: item.name, currentStock: stock });
    }
  }

  return results;
}

/**
 * Find dead items (zero opening stock and zero movement).
 */
export function findDeadItems(
  items: Map<string, CanonicalItem>,
  voucherIndex: VoucherIndex
): Array<{ itemId: string; name: string }> {
  const results: Array<{ itemId: string; name: string }> = [];

  for (const [, item] of items) {
    if (Math.abs(item.openingQtyBase) > EPSILON) continue;
    const itemVouchers = voucherIndex.get(item.itemId);
    if (!itemVouchers || itemVouchers.length === 0) {
      results.push({ itemId: item.itemId, name: item.name });
    }
  }

  return results;
}

/**
 * Find items without GST rates configured.
 */
export function findItemsWithoutGST(
  items: Map<string, CanonicalItem>
): Array<{ itemId: string; name: string }> {
  const results: Array<{ itemId: string; name: string }> = [];

  for (const [, item] of items) {
    if (item.gstRate === undefined || item.gstRate === null) {
      results.push({ itemId: item.itemId, name: item.name });
    }
  }

  return results;
}
