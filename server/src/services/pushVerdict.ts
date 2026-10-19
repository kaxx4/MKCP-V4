/**
 * Keeping a read-back verdict from being overwritten by a weaker one (TALLY-7).
 *
 * When Tally ACCEPTS a voucher and safePush's read-back then finds it stored
 * differently from what was sent (a rounded quantity, a changed amount), the
 * queue row is marked `failed` -- but the voucher IS in the books. Two paths used
 * to undo that verdict:
 *
 *   - `reconcile()` flips any failed/dismissed row to `succeeded` as soon as the
 *     mirror holds a voucher with the row's key or number, without comparing a
 *     single field, so a voucher with a wrong stored quantity ended as a green
 *     "succeeded".
 *   - the requeue route reset the row to attempt 0 and re-sent the same payload,
 *     which reproduces the same difference.
 *
 * The verdict is carried on the row's existing `result` jsonb (no new status, so
 * no migration and no change to the web's status filter). A row carrying it is
 * left `failed` for a person to inspect in Tally; reconcile may only confirm rows
 * that never reached Tally.
 */

export const READBACK_MISMATCH_KEY = "readBackMismatch";

/** The result to store on a row whose read-back found differences. */
export function withReadBackMismatch<T extends object>(result: T | null, differences: string[]): T & { readBackMismatch: string[] } {
  return { ...(result ?? ({} as T)), [READBACK_MISMATCH_KEY]: differences } as T & { readBackMismatch: string[] };
}

/** True when the stored `result` records a read-back mismatch. */
export function hasReadBackMismatch(result: unknown): boolean {
  const v = (result as Record<string, unknown> | null | undefined)?.[READBACK_MISMATCH_KEY];
  return Array.isArray(v) && v.length > 0;
}

/** May the mirror check flip this row to `succeeded`? Not if its read-back failed. */
export function mayReconcileFromMirror(row: { result?: unknown }): boolean {
  return !hasReadBackMismatch(row.result);
}

/** Why a requeue is refused, or null when it is allowed. */
export function requeueRefusal(row: { result?: unknown }): string | null {
  if (!hasReadBackMismatch(row.result)) return null;
  const diffs = ((row.result as Record<string, unknown>)[READBACK_MISMATCH_KEY] as string[]).slice(0, 3).join("; ");
  return `Tally accepted this voucher but stored it differently from what was sent (${diffs}). Sending it again would repeat the same difference. Open the voucher in Tally, correct it there, then dismiss this row.`;
}
