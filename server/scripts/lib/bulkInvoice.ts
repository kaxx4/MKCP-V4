/**
 * Pure decisions of the C13 bulk-invoice harness (test-batch04-dummy.ts).
 * No Tally, no I/O. Tested by scripts/test-bulk-invoice-helpers.ts.
 * Added 5-Nov-2026 after the review of task 0-7.
 */

/**
 * True when the bulk invoice may be in the books and must be treated as LEFT
 * IN PLACE (its party and item kept, the --remove-stamp hint printed).
 * safePush returning ok:false does NOT mean nothing was created: anything past
 * the guard stage was sent. Only a guard refusal is known to send nothing.
 */
export function bulkKept(r: { ok: boolean; stage: string }, foundOnReadBack: boolean): boolean {
  return foundOnReadBack || r.stage !== "guard";
}

/** What a bulk run records in summary.json so a later removal uses the right date. */
export interface BulkRecord { stamp: string; number: string; date: string }

/**
 * The date (YYYYMMDD) a --remove-stamp run deletes the invoice with: Tally
 * finds a voucher to delete by REMOTEID and DATE, so it must be the invoice's
 * own creation date. `--remove-date=YYYYMMDD` wins; else the run's
 * summary.json when it records the same stamp; else refused (never today).
 */
export function removalDate(argv: readonly string[], summary: unknown, stamp: string): { date: string } | { error: string } {
  const arg = argv.find((a) => a.startsWith("--remove-date="))?.slice("--remove-date=".length);
  if (arg !== undefined) return /^\d{8}$/.test(arg) ? { date: arg } : { error: `--remove-date must be YYYYMMDD, got "${arg}"` };
  const bulk = (summary as { bulk?: Partial<BulkRecord> } | null)?.bulk;
  if (bulk && bulk.stamp === stamp && typeof bulk.date === "string" && /^\d{8}$/.test(bulk.date)) return { date: bulk.date };
  return { error: `no creation date for stamp ${stamp}: pass --remove-date=YYYYMMDD, or point at the run's evidence folder (its summary.json records it)` };
}

/** A removal succeeds only when the invoice itself was deleted, and the item and party with it. */
export function removalOk(invoiceDeleted: number, itemRemoved: boolean, partyRemoved: boolean): boolean {
  return invoiceDeleted > 0 && itemRemoved && partyRemoved;
}
