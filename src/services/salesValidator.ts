/**
 * Sales Invoice Validation Service
 * Comprehensive validation against imported Tally data
 */

import type { SalesInvoice, ValidationResult } from "../types/sales";
import type { ParsedData, CanonicalVoucher } from "../types/canonical";

/**
 * Validate a sales invoice against Tally data
 */
export async function validateInvoice(
  invoice: SalesInvoice,
  tallyData: ParsedData | null
): Promise<ValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const discrepancies: ValidationResult["discrepancies"] = [];

  if (!tallyData) {
    return {
      passed: false,
      errors: ["No Tally data available for validation"],
      warnings: [],
      discrepancies: []
    };
  }

  // 1. Validate party exists
  const party = tallyData.ledgers.get(invoice.header.partyId);
  if (!party) {
    errors.push(`Party ${invoice.header.partyId} not found in Tally data`);
  } else if (party.type !== "Customer") {
    warnings.push(`${party.name} is not a customer ledger`);
  }

  // 2. Validate each item
  for (const item of invoice.items) {
    const tallyItem = tallyData.items.get(item.itemId);
    if (!tallyItem) {
      errors.push(`Item ${item.itemId} not found in Tally`);
      continue;
    }

    // 2a. Validate rate hasn't changed significantly
    const currentRate = fetchLatestRate(item.itemId, tallyData.vouchers);
    if (currentRate > 0 && Math.abs(currentRate - item.ratePerBaseUnit) > 0.01) {
      discrepancies.push({
        itemId: item.itemId,
        field: "rate",
        expected: currentRate,
        actual: item.ratePerBaseUnit
      });
      warnings.push(
        `Rate for ${item.itemName} changed from ₹${item.ratePerBaseUnit.toFixed(2)} to ₹${currentRate.toFixed(2)}`
      );
    }

    // 2b. Validate quantity is positive
    if (item.quantity <= 0) {
      errors.push(`Quantity for ${item.itemName} must be positive`);
    }

    // 2c. Validate amount calculation
    const expectedAmount = roundTallyStyle(item.baseQuantity * item.ratePerBaseUnit);
    if (Math.abs(expectedAmount - item.amount) > 0.01) {
      errors.push(
        `Amount for ${item.itemName} mismatch: expected ₹${expectedAmount.toFixed(2)}, got ₹${item.amount.toFixed(2)}`
      );
    }
  }

  // 3. Validate subtotal
  const expectedSubtotal = invoice.items.reduce((sum, item) => sum + item.amount, 0);
  const roundedSubtotal = roundTallyStyle(expectedSubtotal);
  if (Math.abs(roundedSubtotal - invoice.subtotal) > 0.01) {
    errors.push(
      `Subtotal mismatch: expected ₹${roundedSubtotal.toFixed(2)}, got ₹${invoice.subtotal.toFixed(2)}`
    );
  }

  // 4. Check for empty invoice
  if (invoice.items.length === 0) {
    errors.push("Invoice must have at least one item");
  }

  // 5. Validate invoice date is reasonable
  const invoiceDate = new Date(invoice.header.date);
  const today = new Date();
  if (invoiceDate > today) {
    warnings.push("Invoice date is in the future");
  }

  return {
    passed: errors.length === 0,
    errors,
    warnings,
    discrepancies
  };
}

/**
 * Fetch latest rate for an item from actual vouchers
 */
export function fetchLatestRate(itemId: string, vouchers: CanonicalVoucher[]): number {
  let latestRate = 0;
  let latestDate = "";

  for (const voucher of vouchers) {
    if (voucher.voucherType !== "Sales") continue;
    if (voucher.isCancelled) continue;

    for (const line of voucher.lines) {
      if (line.itemId !== itemId) continue;
      if (voucher.date > latestDate) {
        latestDate = voucher.date;
        latestRate = line.rate;
      }
    }
  }

  return latestRate;
}

/**
 * Tally-style rounding (2 decimal places)
 */
export function roundTallyStyle(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Calculate package quantity from base quantity
 */
export function calculatePackageQuantity(
  baseQuantity: number,
  conversionRatio: number
): number {
  return roundTallyStyle(baseQuantity / conversionRatio);
}

/**
 * Calculate package rate from base rate
 */
export function calculatePackageRate(
  baseRate: number,
  conversionRatio: number
): number {
  return roundTallyStyle(baseRate * conversionRatio);
}

/**
 * Get conversion ratio for an item (default 1 if not found)
 */
export function getConversionRatio(itemName: string): number {
  // TODO: Look up in Tally data
  // For now, default to 1:1 ratio
  return 1;
}

/**
 * Get package unit name for an item
 */
export function getPackageUnit(itemName: string): string {
  // TODO: Look up in Tally data
  // For now, return generic "pkg"
  return "pkg";
}
