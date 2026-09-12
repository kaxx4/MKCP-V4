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

/**
 * Bank instrument detail. Without it Tally opens the "Bank Allocation" prompt on
 * every voucher touching a bank ledger — 1,275 of this company's real vouchers
 * carry one, so it is the norm. `instrumentNumber` is the UTR or cheque number,
 * i.e. exactly what a bank statement or screenshot provides.
 */
export interface BankAllocation {
  /** Tally only ever stores: "Cheque/DD" | "Cheque" | "Cash" | "Others". */
  transactionType: string;
  transferMode: string;        // e.g. NEFT, RTGS
  instrumentNumber: string;    // UTR / cheque number
  favouring: string;           // party the instrument is drawn in favour of
  instrumentDate?: string;     // YYYY-MM-DD; defaults to the voucher date
}

export interface LedgerEntry {
  ledgerName: string;
  amount: number;
  isDeemedPositive: boolean;  // true = Debit side
  /**
   * Emit this exact value as `<AMOUNT>`, instead of deriving the sign from
   * `isDeemedPositive`.
   *
   * Normally sign and side move together — debit is a negative amount, credit a
   * positive one. Some real lines break that pairing. `TRADE DISCOUNTS / H.C.`,
   * on 66% of this company's sales, is written by Tally itself as
   * `ISDEEMEDPOSITIVE=No` with a NEGATIVE amount: a *negative credit*, which
   * reduces the credit side rather than adding to the debit side. The usual
   * expression cannot produce that pair, so a discounted invoice built here
   * could never match the shape of the books.
   *
   * Only set this when replaying a shape Tally itself produces. `amount` must
   * still carry the magnitude, because the Dr/Cr balance check and the
   * read-back diff both use it.
   */
  signedAmount?: number;
  /**
   * Mark this line as appropriating to GST, so Tally folds it into the
   * assessable value instead of treating it as a plain expense.
   *
   * Without it a `TRADE DISCOUNTS / H.C.` line does not reduce taxable value:
   * Tally computes expected tax on the GROSS stock amount, disagrees with the
   * tax actually on the voucher, and files it under GSTR-1's "Mismatch between
   * Expected Tax Amount and Modified Tax Amount". The voucher still balances and
   * still reads back correctly — only the return shows the problem.
   *
   * Real discounted invoices in this company carry it as `Goods`.
   */
  appropriateToGst?: "Goods" | "Services";
  isPartyLedger: boolean;
  billAllocations?: BillAllocation[];
  bankAllocation?: BankAllocation;
}

export interface InventoryEntry {
  stockItemName: string;
  quantity: number;
  unit: string;
  rate: number;
  amount: number;
  isDeemedPositive: boolean;  // false = outward (sales)
  salesLedgerName: string;
  /** Required when the company tracks godowns/batches — without a batch
   *  allocation Tally can't place the stock and rejects the whole voucher
   *  with EXCEPTIONS=1 and no error text. Defaults to "Primary Batch". */
  godownName?: string;
  batchName?: string;
}

export interface VoucherPayload {
  /**
   * Caller-assigned identity, written as the VOUCHER tag's `REMOTEID` attribute.
   *
   * This is what makes a voucher correctable. Tally addresses Alter and Delete by
   * REMOTEID, and **a voucher created without one can only ever be created** —
   * `ACTION="Alter"` on it silently performs a Create instead, returning
   * `created=1` (which reads as success) while duplicating real financial data.
   *
   * Always set it. A stable key such as `{type}|{number}|{company}|{date}` also
   * makes a re-pushed voucher idempotent rather than duplicated.
   */
  remoteId?: string;
  /** Create (default), Alter or Delete. Alter and Delete REQUIRE `remoteId`. */
  action?: "Create" | "Alter" | "Delete";
  /**
   * Permit an Alter or Delete against a voucher in a GST period that has already
   * been filed.
   *
   * Altering such a voucher silently changes a return that has been submitted.
   * The guard refuses by default; this is the deliberate override, and it should
   * only ever be set by a person who knows the return will be revised.
   */
  allowFiledPeriodEdit?: boolean;
  /**
   * "Sales Order Note" and "Contra" are both in daily use here and were being
   * cast in at call sites, which defeats the point of the union.
   */
  voucherType: "Sales" | "Purchase" | "Receipt" | "Payment" | "Contra" | "Credit Note"
    | "Debit Note" | "Journal" | "Sales Order Note" | "Delivery Note" | "Receipt Note";
  date: string;               // YYYY-MM-DD
  voucherNumber?: string;
  reference?: string;
  narration?: string;
  partyLedgerName: string;
  /**
   * Declare the place of supply when the party ledger cannot carry one.
   *
   * The single real case is a counter sale billed to the shared `Cash` ledger.
   * That ledger has no state — it cannot have one, since it is not a party — so
   * Tally cannot derive a place of supply and the voucher lands in GSTR-1 under
   * "GST Registration Details of the Party are invalid or not specified". About
   * a third of this company's sales are cash, so without this they cannot be
   * pushed at all.
   *
   * Accepted on OUTWARD vouchers only, where the place of supply and the
   * counterparty's state are the same thing. On an inward voucher the place of
   * supply is always ours and carries no information about the supplier, so the
   * guard REFUSES it there rather than ignoring it.
   *
   * A ledger that already has a state always wins; this never overrides Tally.
   */
  placeOfSupply?: string;
  isInvoice: boolean;
  ledgerEntries: LedgerEntry[];
  inventoryEntries?: InventoryEntry[];
}

export interface PushResult {
  success: boolean;
  created: number;
  errors: number;
  lastVoucherId: string | null;
  lineErrors: string[];
  rawResponse: string;
}
