// ══ CANONICAL TYPES — all internal data uses ONLY these ══════════════════

export type UnitMode = "BASE" | "PKG";

export type VoucherType =
  | "Sales" | "Purchase" | "Receipt" | "Payment"
  | "Journal" | "Contra" | "Debit Note" | "Credit Note"
  | "Stock Journal" | "Delivery Note"
  | "Sales Order" | "Quotation"
  | "Other";

export interface CompanyInfo {
  name: string;
  gstin?: string;
  fyStartMonth: number; // 1=Jan, 4=April (default for India)
}

export interface DealerPrice {
  priceListName: string;   // e.g. "Dealer Price List A"
  dealerRate: number;      // dealer-specific rate per base unit
  dealerDiscount?: number; // discount percentage (if specified in Tally)
  barcode?: string;        // optional barcode from price list
}

export interface CanonicalItem {
  itemId: string;          // normalized uppercase name used as key
  name: string;            // display name (original case from JSON)
  group: string;           // stock group (immediate parent)
  category?: string;       // stock category
  baseUnit: string;        // e.g. "PCS", "KG"
  pkgUnit: string | null;  // e.g. "BOX", null if not configured
  unitsPerPkg: number;     // 1 if no package unit
  openingQtyBase: number;  // opening stock in base units for active FY
  openingRate: number;     // rate per base unit at opening
  openingValue: number;    // total opening value
  closingQtyBase?: number; // closing stock in base units for active FY
  closingRate?: number;    // rate per base unit at closing
  closingValue?: number;   // total closing value
  hsn?: string;
  gstRate?: number;
  dealerPrices?: DealerPrice[]; // dealer-specific rates from price lists
}

export interface CanonicalLedger {
  ledgerId: string;        // normalized uppercase name
  name: string;
  group: string;           // "Sundry Debtors" | "Sundry Creditors" | "Bank Accounts" | etc.
  openingBalance: number;  // positive = Dr (receivable/asset), negative = Cr (payable/liability)
  gstin?: string;
  creditDays: number;
  pincode?: string;
  state?: string;
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
  /** Tally's monotonic alteration id (bumps on every edit). Used as the
   *  high-water mark for incremental "re-pull anything changed" sync. */
  alterId?: number;
}

/** Tally's authoritative P&L report — fetched directly from Tally during sync */
export interface TallyPLSnapshot {
  sales: number; costOfSales: number; openingStock: number; purchases: number;
  closingStock: number; directExpenses: number; indirectIncome: number;
  indirectExpenses: number; netProfit: number;
}

/** Tally's authoritative Balance Sheet — fetched directly from Tally during sync */
export interface TallyBSSnapshot {
  capitalAccount: number; loans: number; currentLiabilities: number;
  profitAndLoss: number; fixedAssets: number; investments: number; currentAssets: number;
}

export interface ParsedData {
  company: CompanyInfo | null;
  items: Map<string, CanonicalItem>;      // key = itemId
  ledgers: Map<string, CanonicalLedger>; // key = ledgerId
  vouchers: CanonicalVoucher[];
  importedAt: string;
  sourceFiles: string[];
  warnings: ImportWarning[];
  tallyPL?: TallyPLSnapshot;   // authoritative P&L from Tally (if fetched)
  tallyBS?: TallyBSSnapshot;   // authoritative BS from Tally (if fetched)
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

export interface GstOverride {
  itemId: string;
  gstPct: number;       // user-set GST % (0..28 typical); overrides master + inference
  updatedAt: string;
}

export interface AuditEntry {
  type: "rate_update" | "unit_override" | "gst_override" | "master_edit" | "import" | "system";
  itemId?: string;
  ledgerId?: string;
  oldValue?: unknown;
  newValue?: unknown;
  at: string;
  by: string;
}
