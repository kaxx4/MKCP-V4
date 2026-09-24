/**
 * Bulk payments and receipts.
 *
 * The single largest block of repetitive manual entry in this business:
 * ~151 payments and ~101 receipts a month, against 124 distinct payees, with
 * `Coolie Charges` alone recurring 301 times a year.
 *
 * One payment is one voucher (owner's rule), so a batch of N rows produces N
 * vouchers. Each is guarded, pushed and verified independently — a bad row is
 * rejected on its own rather than taking the batch with it.
 */
import { loadMasters, resolveLedger } from "./tallyMasters.js";
import { remoteIdFor } from "./remoteId.js";
import { loadOpenBills, billsForParty, allocateFIFO, receivableBills, payableBills, type OpenBill } from "./billSettlement.js";
import { safePush, type SafePushResult } from "./safePush.js";
import { assertWritable } from "./tallyGate.js";
import type { VoucherPayload, BankAllocation } from "../types.js";

export interface BulkRow {
  /** Ledger name of the customer (receipt) or supplier (payment). */
  party: string;
  amount: number;
  /** YYYY-MM-DD; defaults to today. */
  date?: string;
  narration?: string;
  /** Bank/cash ledger the money moved through. */
  account: string;
  /** UTR / cheque number and mode. Omit for cash, which is entered manually. */
  instrument?: Omit<BankAllocation, "favouring">;
  voucherNumber?: string;
}

export interface BulkRowResult {
  row: BulkRow;
  ok: boolean;
  voucherId: string | null;
  /** What the amount was decided to clear. */
  settledBills: Array<{ name: string; amount: number }>;
  onAccount: number;
  errors: string[];
  differences: string[];
}

export interface BulkResult {
  kind: "receipt" | "payment";
  total: number;
  succeeded: number;
  failed: number;
  /** Sum of amounts that could not be matched to a bill. */
  onAccountTotal: number;
  rows: BulkRowResult[];
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);

/**
 * Build one voucher for one row. Exported so a UI can preview exactly what will
 * be written — including which bills it clears — before anything is sent.
 */
export function buildBulkVoucher(
  kind: "receipt" | "payment",
  row: BulkRow,
  openBills: OpenBill[],
  seq: number
): { payload: VoucherPayload; settled: Array<{ name: string; amount: number }>; onAccount: number } {
  const partyBills = billsForParty(
    kind === "receipt" ? receivableBills(openBills) : payableBills(openBills),
    row.party
  );
  const plan = allocateFIFO(partyBills, row.amount);
  const amount = r2(Math.abs(row.amount));
  const date = row.date ?? today();
  const number = row.voucherNumber ?? `BULK/${kind === "receipt" ? "R" : "P"}/${Date.now().toString().slice(-6)}/${seq}`;

  // Only "Agst Ref" rows become bill allocations. An On Account remainder is
  // simply left off — Tally holds it against the party without a reference,
  // which is exactly what the books already do for unmatched money.
  const billAllocations = plan.allocations
    .filter(a => a.billType === "Agst Ref")
    .map(a => ({ name: a.name, billType: "Agst Ref" as const, amount: a.amount }));

  // Allocations must sum EXACTLY to the party line or Tally refuses the voucher,
  // so when part of the amount is on account, send no allocations at all.
  const useAllocations = billAllocations.length > 0 && plan.onAccount === 0;

  const bank: BankAllocation | undefined = row.instrument
    ? { ...row.instrument, favouring: row.party }
    : undefined;

  const partyLine = {
    ledgerName: row.party,
    amount,
    // A receipt credits the customer; a payment debits the supplier.
    isDeemedPositive: kind === "payment",
    isPartyLedger: true,
    ...(useAllocations ? { billAllocations } : {}),
  };
  const accountLine = {
    ledgerName: row.account,
    amount,
    isDeemedPositive: kind === "receipt",   // money into the bank is a debit
    isPartyLedger: false,
    ...(bank ? { bankAllocation: bank } : {}),
  };

  return {
    payload: {
      voucherType: kind === "receipt" ? "Receipt" : "Payment",
      date,
      voucherNumber: number,
      /* G5: identity from creation. pushGuard refuses a Create without one
         (24-Sep-2026); same derivation as bankToReceipts. */
      remoteId: remoteIdFor({ voucherType: kind === "receipt" ? "Receipt" : "Payment", voucherNumber: number, date }),
      narration: row.narration ?? (kind === "receipt" ? "RTGS RECEIVED" : "AS PER BILL"),
      partyLedgerName: row.party,
      isInvoice: false,
      ledgerEntries: kind === "receipt" ? [accountLine, partyLine] : [partyLine, accountLine],
    },
    settled: useAllocations ? billAllocations.map(b => ({ name: b.name, amount: b.amount })) : [],
    onAccount: plan.onAccount,
  };
}

/**
 * Push a batch. Rows are sent one at a time on purpose: Tally is single-threaded
 * on its XML port, and a failure must not cascade — an error there freezes the
 * application until it is restarted, so the run stops on a transport failure
 * rather than hammering a dead port.
 */
export async function pushBulk(
  tallyUrl: string,
  company: string,
  kind: "receipt" | "payment",
  rows: BulkRow[]
): Promise<BulkResult> {
  // Find out Tally is unavailable BEFORE writing 60 vouchers, not on the 31st.
  await assertWritable(tallyUrl);
  await loadMasters(tallyUrl, company);            // warm the cache once for the batch
  const openBills = await loadOpenBills(tallyUrl, company);

  const results: BulkRowResult[] = [];
  let seq = 0;

  // Working copy. Tally's snapshot is a point in time, but within a batch each
  // successful row consumes outstanding amounts that later rows must not
  // allocate against again — otherwise two receipts in the same run both settle
  // the same invoice and the second one is wrong.
  const working: OpenBill[] = openBills.map(b => ({ ...b }));

  for (const row of rows) {
    seq++;
    const { payload, settled, onAccount } = buildBulkVoucher(kind, row, working, seq);
    let res: SafePushResult;
    try {
      res = await safePush(tallyUrl, company, payload);
    } catch (e) {
      results.push({ row, ok: false, voucherId: null, settledBills: settled, onAccount,
        errors: [`Transport failure: ${(e as Error).message}. Stopping the batch — Tally may need a restart.`],
        differences: [] });
      break;
    }
    // Draw down what this row actually settled, so the next row sees the truth.
    //
    // Gated on the voucher having been CREATED, not on it verifying perfectly.
    // Once Tally has the voucher the bill is settled in its books, so a later
    // row must not allocate against it again — even if the read-back diff found
    // something else to complain about. Gating this on full verification caused
    // exactly that: a cosmetic diff failure let the next row re-settle the same bill.
    if (res.voucherId) {
      for (const s of settled) {
        const b = working.find(x => x.name === s.name && x.party === row.party);
        if (!b) continue;
        b.outstanding = r2(Math.max(0, b.outstanding - s.amount));
        b.closing = b.closing < 0 ? -b.outstanding : b.outstanding;
      }
      // Fully settled bills drop out of the pool entirely.
      for (let i = working.length - 1; i >= 0; i--) {
        if (working[i].outstanding <= 0.009) working.splice(i, 1);
      }
    }

    results.push({
      row, ok: res.ok, voucherId: res.voucherId, settledBills: settled, onAccount,
      errors: res.errors, differences: res.differences,
    });
  }

  return {
    kind,
    total: rows.length,
    succeeded: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok).length,
    onAccountTotal: r2(results.reduce((s, r) => s + r.onAccount, 0)),
    rows: results,
  };
}

/** Resolve a party name to its exact Tally spelling, or explain why it can't be. */
export async function resolveParty(tallyUrl: string, company: string, name: string): Promise<string> {
  const m = await loadMasters(tallyUrl, company);
  return resolveLedger(m, name).name;
}
