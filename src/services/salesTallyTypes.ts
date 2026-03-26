// Shared Tally push types (re-exported from salesTallyConverter for convenience)

export interface BillAllocation {
  name: string;
  billType: "New Ref" | "Agst Ref" | "Advance" | "On Account";
  amount: number;
}

export interface LedgerEntry {
  ledgerName: string;
  amount: number;
  isDeemedPositive: boolean;
  isPartyLedger: boolean;
  billAllocations?: BillAllocation[];
}

export interface InventoryEntry {
  stockItemName: string;
  quantity: number;
  unit: string;
  rate: number;
  amount: number;
  isDeemedPositive: boolean;
  salesLedgerName: string;
}

export interface VoucherPayload {
  voucherType: "Sales" | "Purchase" | "Receipt" | "Payment" | "Credit Note" | "Debit Note" | "Journal";
  date: string;
  voucherNumber?: string;
  reference?: string;
  narration?: string;
  partyLedgerName: string;
  isInvoice: boolean;
  ledgerEntries: LedgerEntry[];
  inventoryEntries?: InventoryEntry[];
}
