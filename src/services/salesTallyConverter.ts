/**
 * Sales Invoice → Tally XML Converter (V2)
 * Correct Tally Import Data format per TallyPrime official docs.
 */

import type { SalesInvoice } from '../types/sales';
import type { CanonicalLedger } from '../types/canonical';
import type { PushResult } from '../types/sales';
import type { VoucherPayload, LedgerEntry, InventoryEntry } from './salesTallyTypes';

export type { VoucherPayload, LedgerEntry, InventoryEntry };

export interface TallyPushConfig {
  companyName: string;
  companyState: string;         // "West Bengal"
  salesLedgerName: string;      // default "Sales"
  cgstLedgerName: string;       // default "Output CGST"
  sgstLedgerName: string;       // default "Output SGST"
  igstLedgerName: string;       // default "Output IGST"
  proxyUrl: string;             // default "http://localhost:3100"
}

export const DEFAULT_PUSH_CONFIG: TallyPushConfig = {
  companyName: "M.K.CYCLES (P) LTD.",
  companyState: "West Bengal",
  salesLedgerName: "Sales",
  cgstLedgerName: "Output CGST",
  sgstLedgerName: "Output SGST",
  igstLedgerName: "Output IGST",
  proxyUrl: "http://localhost:3100",
};

/** Determine GST type based on GSTIN state code comparison */
export function determineGSTType(
  companyState: string,
  partyState: string | undefined
): "intra" | "inter" {
  // West Bengal = state code 19
  // If party has no GSTIN or state → default to intra (local B2C)
  if (!partyState) return "intra";
  // Normalize state comparison
  const normalized = partyState.trim().toLowerCase();
  if (normalized === "west bengal" || normalized.startsWith("19")) return "intra";
  return "inter";
}

/** Determine GST type from GSTIN prefix (first 2 digits = state code) */
export function gstTypeFromGSTIN(
  gstin: string | undefined,
  companyStateCode = "19"
): "intra" | "inter" {
  if (!gstin || gstin.length < 2) return "intra";
  const partyStateCode = gstin.substring(0, 2);
  return partyStateCode === companyStateCode ? "intra" : "inter";
}

/** Build GST ledger entries for a taxable amount */
export function buildGSTLedgerEntries(
  taxableAmount: number,
  gstRate: number,
  gstType: "intra" | "inter",
  config: TallyPushConfig
): LedgerEntry[] {
  if (gstRate === 0) return [];
  const total = Math.round(taxableAmount * gstRate) / 100;

  if (gstType === "intra") {
    const half = Math.round(total * 100) / 200; // Each 50%
    return [
      { ledgerName: config.cgstLedgerName, amount: half, isDeemedPositive: false, isPartyLedger: false },
      { ledgerName: config.sgstLedgerName, amount: half, isDeemedPositive: false, isPartyLedger: false },
    ];
  } else {
    return [
      { ledgerName: config.igstLedgerName, amount: total, isDeemedPositive: false, isPartyLedger: false },
    ];
  }
}

/** Convert a SalesInvoice to a VoucherPayload for Tally push */
export function convertInvoiceToVoucherPayload(
  invoice: SalesInvoice,
  partyLedger: CanonicalLedger | undefined,
  config: TallyPushConfig
): VoucherPayload {
  const invoiceNo = invoice.header.invoiceNo || invoice.header.id.substring(0, 12);
  const gstType = gstTypeFromGSTIN(partyLedger?.gstin ?? invoice.header.partyGST, "19");

  // Build inventory entries
  const inventoryEntries: InventoryEntry[] = invoice.items.map(item => ({
    stockItemName: item.itemName,
    quantity: item.baseQuantity,
    unit: item.baseUnitName || "Nos",
    rate: item.ratePerBaseUnit,
    amount: item.amount,
    isDeemedPositive: false,          // false = outward (sold)
    salesLedgerName: config.salesLedgerName,
  }));

  // Sales ledger entry (Credit)
  const salesLedgerEntry: LedgerEntry = {
    ledgerName: config.salesLedgerName,
    amount: invoice.subtotal,
    isDeemedPositive: false,
    isPartyLedger: false,
  };

  // GST entries (if applicable — no GST for M.K. Cycles per constraints)
  const gstEntries: LedgerEntry[] = [];

  // Total = subtotal + GST
  const grandTotal = invoice.subtotal + gstEntries.reduce((sum, e) => sum + e.amount, 0);

  // Party ledger entry (Debit)
  const partyEntry: LedgerEntry = {
    ledgerName: invoice.header.partyName,
    amount: grandTotal,
    isDeemedPositive: true,   // true = Debit
    isPartyLedger: true,
    billAllocations: [
      {
        name: invoiceNo,
        billType: "New Ref",
        amount: grandTotal,
      },
    ],
  };

  return {
    voucherType: "Sales",
    date: invoice.header.date,
    voucherNumber: invoiceNo,
    reference: invoiceNo,
    narration: `Pro-forma invoice from MKCP Dashboard - ${invoiceNo}`,
    partyLedgerName: invoice.header.partyName,
    isInvoice: true,
    ledgerEntries: [partyEntry, salesLedgerEntry, ...gstEntries],
    inventoryEntries,
  };
}

/** Validate invoice before push */
export function validateInvoiceForPush(invoice: SalesInvoice): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!invoice.header.partyName) errors.push("Party name is required");
  if (!invoice.header.date) errors.push("Invoice date is required");
  if (invoice.items.length === 0) errors.push("Invoice must have at least one item");
  for (const item of invoice.items) {
    if (!item.itemName) errors.push("Item name is missing");
    if (item.baseQuantity <= 0) errors.push(`Quantity for "${item.itemName}" must be > 0`);
    if (item.ratePerBaseUnit <= 0) errors.push(`Rate for "${item.itemName}" must be > 0`);
  }
  return { valid: errors.length === 0, errors };
}

/** Push a single invoice to Tally via proxy API */
export async function pushInvoiceToTally(
  invoice: SalesInvoice,
  partyLedger: CanonicalLedger | undefined,
  config: TallyPushConfig = DEFAULT_PUSH_CONFIG
): Promise<PushResult> {
  const validation = validateInvoiceForPush(invoice);
  if (!validation.valid) {
    return {
      success: false,
      created: 0,
      errors: validation.errors.length,
      lastVoucherId: null,
      lineErrors: validation.errors,
      rawResponse: "",
    };
  }

  const payload = convertInvoiceToVoucherPayload(invoice, partyLedger, config);

  try {
    const r = await fetch(`${config.proxyUrl}/api/tally/push-voucher`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ company: config.companyName, voucher: payload }),
    });
    if (!r.ok) {
      const text = await r.text();
      return { success: false, created: 0, errors: 1, lastVoucherId: null, lineErrors: [`HTTP ${r.status}: ${text}`], rawResponse: text };
    }
    return await r.json() as PushResult;
  } catch (e: any) {
    return { success: false, created: 0, errors: 1, lastVoucherId: null, lineErrors: [e.message], rawResponse: "" };
  }
}

/** Push multiple invoices to Tally */
export async function pushBatchToTally(
  invoices: SalesInvoice[],
  ledgerMap: Map<string, CanonicalLedger>,
  config: TallyPushConfig = DEFAULT_PUSH_CONFIG
): Promise<{ results: PushResult[]; successCount: number; errorCount: number }> {
  const payloads = invoices
    .filter(inv => validateInvoiceForPush(inv).valid)
    .map(inv => convertInvoiceToVoucherPayload(inv, ledgerMap.get(inv.header.partyId.toUpperCase()), config));

  try {
    const r = await fetch(`${config.proxyUrl}/api/tally/push-batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ company: config.companyName, vouchers: payloads }),
    });
    if (!r.ok) {
      const text = await r.text();
      const errResult: PushResult = { success: false, created: 0, errors: 1, lastVoucherId: null, lineErrors: [text], rawResponse: text };
      return { results: invoices.map(() => errResult), successCount: 0, errorCount: invoices.length };
    }
    return await r.json();
  } catch (e: any) {
    const errResult: PushResult = { success: false, created: 0, errors: 1, lastVoucherId: null, lineErrors: [e.message], rawResponse: "" };
    return { results: invoices.map(() => errResult), successCount: 0, errorCount: invoices.length };
  }
}
