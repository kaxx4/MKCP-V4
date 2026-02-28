// ══ CANONICAL TYPES — all internal data uses ONLY these ══════════════════

export type UnitMode = "BASE" | "PKG";

export type VoucherType =
  | "Sales" | "Purchase" | "Receipt" | "Payment"
  | "Journal" | "Contra" | "Debit Note" | "Credit Note"
  | "Stock Journal" | "Other";

export interface CompanyInfo {
  name: string;
  gstin?: string;
  fyStartMonth: number; // 1=Jan, 4=April (default for India)
}

export interface CanonicalItem {
  itemId: string;          // normalized uppercase name used as key
  name: string;            // display name (original case from JSON)
  group: string;           // stock group
  baseUnit: string;        // e.g. "PCS", "KG"
  pkgUnit: string | null;  // e.g. "BOX", null if not configured
  unitsPerPkg: number;     // 1 if no package unit
  openingQtyBase: number;  // opening stock in base units for active FY
  openingRate: number;     // rate per base unit at opening
  openingValue: number;    // total opening value
  hsn?: string;
  gstRate?: number;
}

export interface CanonicalLedger {
  ledgerId: string;        // normalized uppercase name
  name: string;
  group: string;           // "Sundry Debtors" | "Sundry Creditors" | "Bank Accounts" | etc.
  openingBalance: number;  // positive = Dr (receivable/asset), negative = Cr (payable/liability)
  gstin?: string;
  creditDays: number;
}

export interface CanonicalVoucherLine {
  type: "ledger" | "inventory";
  // Ledger line:
  ledgerId?: string;
  isDebit?: boolean;
  amount?: number;
  billAllocations?: CanonicalBillAlloc[];
  isPartyLine?: boolean;
  // Inventory line:
  itemId?: string;
  qtyBase?: number;       // always base units
  ratePerBase?: number;
  lineAmount?: number;
}

export interface CanonicalBillAlloc {
  billRef: string;
  billType: "New Ref" | "Agst Ref" | "Advance" | "On Account";
  amount: number;
  dueDate?: string; // ISO date string
}

export interface CanonicalVoucher {
  voucherId: string;
  voucherNumber: string;
  voucherType: VoucherType;
  date: string;           // ISO date YYYY-MM-DD
  partyLedgerId?: string;
  partyName?: string;
  totalAmount: number;
  narration?: string;
  isCancelled: boolean;
  isOptional: boolean;
  lines: CanonicalVoucherLine[];
}

export interface ParsedData {
  company: CompanyInfo | null;
  items: Map<string, CanonicalItem>;      // key = itemId
  ledgers: Map<string, CanonicalLedger>; // key = ledgerId
  vouchers: CanonicalVoucher[];
  importedAt: string;
  sourceFiles: string[];
  warnings: ImportWarning[];
}

export interface ImportWarning {
  severity: "fatal" | "warn" | "info";
  context: string;
  message: string;
}

// Monthly inventory summary for one item
export interface MonthBucket {
  yearMonth: string;      // "2024-04"
  label: string;          // "Apr 24"
  openingQtyBase: number;
  inwardsBase: number;
  outwardsBase: number;
  closingQtyBase: number;
}

// Override shapes
export interface UnitOverride {
  itemId: string;
  pkgUnit: string;
  unitsPerPkg: number;
  source: "manual" | "import";
  confidence: number;
  updatedAt: string;
}

export interface RateOverride {
  itemId: string;
  unitRate: number;
  pkgRate: number | null;
  updatedAt: string;
}

export interface AuditEntry {
  type: "rate_update" | "unit_override" | "master_edit" | "import" | "system";
  itemId?: string;
  ledgerId?: string;
  oldValue?: unknown;
  newValue?: unknown;
  at: string;
  by: string;
}
