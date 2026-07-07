// ─────────────────────────────────────────────────────────────────────────────
// Shared types for the reworked import engine
// ─────────────────────────────────────────────────────────────────────────────

export interface CollectionDef {
  name: string;              // "stockItems", "ledgers", "vouchers", etc.
  tallyCollection: string;   // "StockItem", "Ledger", "Voucher"
  metadataType: string;      // "Stock Item", "Ledger", "Voucher" (parser compat)
  category: "master" | "transaction";
  fetch?: string[];          // Fields to FETCH
  compute?: { name: string; expression: string }[];
  filters?: { name: string; expression?: string }[];
  timeout: number;           // per-request timeout in ms
  parallel: boolean;         // can this be fetched in parallel with others?
}

export interface SyncPlan {
  company: string;
  fromDate: string;          // YYYYMMDD
  toDate: string;            // YYYYMMDD
  mode: "full" | "incremental" | "masters-only" | "vouchers-only";
  chunkStrategy: "smart" | "monthly" | "weekly" | "daily";
  signal?: AbortSignal;
}

export interface SyncProgress {
  phase: string;
  step: number;
  totalSteps: number;
  detail: string;
  timestamp: number;
}

export interface AlterIdSnapshot {
  masterId: number;
  transactionId: number;
  fetchedAt: string;
}

export interface VoucherBatch {
  from: string;              // YYYYMMDD
  to: string;                // YYYYMMDD
  label: string;
  estimatedCount: number;
}

export interface SyncResult {
  success: boolean;
  errors?: string[];
  error?: string;
  masters: { tallymessage: any[] };
  transactions: { tallymessage: any[] };
  stats: {
    stockGroups: number;
    units: number;
    stockItems: number;
    ledgers: number;
    godowns: number;
    costCentres: number;
    vouchers: number;
    elapsedSeconds: number;
  };
}

export interface MastersSyncResult {
  success: boolean;
  errors?: string[];
  data: { tallymessage: any[] };
  stats: {
    stockGroups: number;
    units: number;
    stockItems: number;
    ledgers: number;
    godowns: number;
    costCentres: number;
    dealerPriceLists: number;
    elapsedSeconds: number;
  };
}

export interface VouchersSyncResult {
  success: boolean;
  error?: string;
  errors?: string[];
  data: { tallymessage: any[] };
  stats: {
    vouchers: number;
    fromDate: string;
    toDate: string;
    chunksTotal: number;
    chunksSucceeded: number;
    chunksFailed: number;
    chunkDetails?: { label: string; count: number; ms: number }[];
    /** Days (YYYYMMDD) whose single-day chunk succeeded — same list the server
     *  uses for its own per-day Supabase prune (meta.pruneDays). Only populated
     *  for the "daily" chunk strategy. The client uses this to clear its local
     *  copy of the same days instead of gating on the whole range being clean. */
    succeededDays?: string[];
    /** Whether the server's own Supabase vouchers upload+prune actually succeeded
     *  (false if it threw, or if the run was aborted before ever attempting it).
     *  This is now the ONLY voucher-push confirmation the client gets — the
     *  redundant unpruned /api/supabase/sync push no longer carries vouchers. */
    vouchersUploadOk: boolean;
    elapsedSeconds: number;
  };
}

// ── Voucher Push Types ────────────────────────────────────────────────────────

export interface BillAllocation {
  name: string;
  billType: "New Ref" | "Agst Ref" | "Advance" | "On Account";
  amount: number;
}

export interface LedgerEntry {
  ledgerName: string;
  amount: number;
  isDeemedPositive: boolean;  // true = Debit side
  isPartyLedger: boolean;
  billAllocations?: BillAllocation[];
}

export interface InventoryEntry {
  stockItemName: string;
  quantity: number;
  unit: string;
  rate: number;
  amount: number;
  isDeemedPositive: boolean;  // false = outward (sales)
  salesLedgerName: string;
}

export interface VoucherPayload {
  voucherType: "Sales" | "Purchase" | "Receipt" | "Payment" | "Credit Note" | "Debit Note" | "Journal" | "Delivery Note" | "Receipt Note";
  date: string;               // YYYY-MM-DD
  voucherNumber?: string;
  reference?: string;
  narration?: string;
  partyLedgerName: string;
  isInvoice: boolean;
  ledgerEntries: LedgerEntry[];
  inventoryEntries?: InventoryEntry[];
}

export interface PushVoucherRequest {
  company: string;
  voucher: VoucherPayload;
}

export interface PushBatchRequest {
  company: string;
  vouchers: VoucherPayload[];
}

export interface PushResult {
  success: boolean;
  created: number;
  errors: number;
  lastVoucherId: string | null;
  lineErrors: string[];
  rawResponse: string;
}
