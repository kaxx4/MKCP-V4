/**
 * Sales Invoice Type Definitions
 * Pro-forma sales invoices with Tally integration
 */

export interface SalesInvoiceLineItem {
  id: string; // UUID for form management
  itemId: string; // Reference to Tally stock item
  itemName: string; // From Tally stock master
  quantity: number; // User-entered
  unitType: "base" | "package"; // Current display unit
  baseQuantity: number; // Always in base units (calculated)
  packageQuantity: number; // In package units (calculated)

  // SOURCED FROM TALLY (read-only)
  ratePerBaseUnit: number; // ₹ per base unit (from Tally rates)
  ratePerPackageUnit: number; // ₹ per package (calculated from base rate)
  conversionRatio: number; // packages per base unit (from Tally)
  baseUnitName: string; // e.g., "piece", "kg"
  packageUnitName: string; // e.g., "box", "carton"

  // CALCULATED
  amount: number; // quantity × rate (Tally-rounding)

  // AUDIT
  validationStatus: "valid" | "invalid" | "warning";
  validationMessages: string[];
}

export interface SalesInvoiceHeader {
  id: string; // Temporary invoice ID
  invoiceNo?: string; // Optional user-input
  date: string; // YYYY-MM-DD
  partyId: string; // Tally ledger ID
  partyName: string; // Ledger name
  partyGST?: string; // For reference only (NOT USED IN CALCS)

  // Metadata
  createdAt: string;
  modifiedAt: string;
  status: "draft" | "ready_for_export" | "exported";
}

export interface SalesInvoice {
  header: SalesInvoiceHeader;
  items: SalesInvoiceLineItem[];

  // CALCULATED
  subtotal: number; // Sum of all item amounts
  totalQuantity: number; // Total items (in base units)

  // AUDIT
  auditLog: AuditLogEntry[];
  isValid: boolean;
  validationErrors: string[];
}

export interface AuditLogEntry {
  timestamp: string;
  action: string; // "created", "item_added", "quantity_changed", "unit_toggled", "validated"
  details: Record<string, unknown>;
  validationResult?: {
    passed: boolean;
    discrepancies: string[];
  };
}

export interface ValidationResult {
  passed: boolean;
  errors: string[];
  warnings: string[];
  discrepancies: {
    itemId: string;
    field: string;
    expected: unknown;
    actual: unknown;
  }[];
}

export interface TestCase {
  name: string;
  description: string;
  passed: boolean;
  details: string;
}

export interface TestResult {
  timestamp: string;
  totalTests: number;
  passedTests: number;
  failedTests: number;
  testCases: TestCase[];
}

export interface PushResult {
  success: boolean;
  created: number;
  errors: number;
  lastVoucherId: string | null;
  lineErrors: string[];
  rawResponse: string;
}

export interface InvoicePrintConfig {
  format: "a4" | "thermal";
  companyName: string;
  companyAddress: string;
  companyGSTIN: string;
  companyState: string;
  companyPhone?: string;
  companyEmail?: string;
  showLogo: boolean;
  footerText?: string;
}
