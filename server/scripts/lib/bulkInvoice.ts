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
export function bulkKept(r: { ok: boolean; stage: string } | "threw", foundOnReadBack: boolean): boolean {
  /* A throw (a timeout, a dropped socket) may come after Tally accepted the
     invoice, so it is kept too (review, 5-Nov-2026). */
  if (r === "threw") return true;
  return foundOnReadBack || r.stage !== "guard";
}

/** The exact command that removes what a bulk run left, for the LEFT IN PLACE hint. */
export function removalCommand(evidenceDir: string, stamp: string, day: string): string {
  return `cd server && npx tsx --env-file=.env scripts/test-batch04-dummy.ts "${evidenceDir}" --remove-stamp=${stamp} --remove-date=${day}`;
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

/** What a removal did, and what the read-back afterwards shows. */
export interface RemovalFacts {
  invoiceDeleted: number; invoiceStillThere: boolean;
  itemRemoved: boolean; itemStillThere: boolean;
  partyRemoved: boolean; partyStillThere: boolean;
}
export type RemovalVerdict = "removed" | "already removed" | "failed";

/**
 * "removed" when this run deleted the invoice and nothing is left; "already
 * removed" when the invoice was not deleted now but the read-back shows it,
 * the item and the party absent (a re-run, review 5-Nov-2026); "failed" when
 * anything is still in the books. Decided by what is in the books, never by
 * a delete count alone.
 */
export function removalVerdict(f: RemovalFacts): RemovalVerdict {
  if (f.invoiceStillThere || f.itemStillThere || f.partyStillThere) return "failed";
  return f.invoiceDeleted > 0 ? "removed" : "already removed";
}

export const removalExit = (v: RemovalVerdict): number => (v === "failed" ? 1 : 0);
