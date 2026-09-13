/**
 * What a verification script on THIS machine is actually able to observe.
 *
 * ── The failure this exists to stop ───────────────────────────────────────
 *
 * `MKCP_TALLY_ROLE=sandbox` makes `supabaseClient()` return null, so every
 * write through `SupabaseSync` is a silent no-op. A script that calls
 * `syncMasters(...)` and then COUNTS rows with its own direct client counts
 * rows that were already there — and reports them as landed.
 *
 * That happened on 13-Sep-2026. `verify-master-fields.ts` printed eight green
 * checks including "costing_method landed — 492 rows", while the column held
 * an empty string on every one of those rows and the sync had written nothing
 * at all. The rows that DID carry new columns had been written by the
 * separately-running agent process, not by the script claiming credit.
 *
 * Guardrail P7: every verification states what it cannot see. This makes that
 * mechanical rather than remembered — a script asks before it claims.
 */
import { isOffline, offlineReason } from "./supabaseClient.js";

export interface VerifyContext {
  /** Can this process write to the shared mirror at all? */
  canWrite: boolean;
  /** Why not, in one line, when it cannot. */
  why: string | null;
}

export function verifyContext(): VerifyContext {
  const off = isOffline();
  return { canWrite: !off, why: off ? offlineReason() : null };
}

/**
 * Print the header a verification script owes its reader.
 *
 * Says up front which half of the pipeline this run can speak to, so a green
 * result further down cannot be mistaken for more than it is.
 */
export function announceVerifyContext(what: string): VerifyContext {
  const ctx = verifyContext();
  if (ctx.canWrite) {
    console.log(`  ${what}: this process CAN write to the mirror — landing checks are real.\n`);
  } else {
    console.log(`  ${what}: this process CANNOT write to the mirror (${ctx.why}).`);
    console.log(`  Anything already in Supabase was put there by an earlier run or by the`);
    console.log(`  running agent. Landing is therefore REPORTED, NOT VERIFIED, below.\n`);
  }
  return ctx;
}

/**
 * Assert a column really carries values, not just non-nulls.
 *
 * A text column that Tally never sent arrives as `""` — non-null, and
 * therefore "landed" to any check that only asks `IS NOT NULL`. That is how
 * `costing_method` read as present on 492 rows while being empty on all of
 * them. Counting is not enough; the values have to be looked at.
 */
export function columnIsReallyFilled(values: unknown[]): { filled: number; empty: number; nulls: number } {
  let filled = 0, empty = 0, nulls = 0;
  for (const v of values) {
    if (v === null || v === undefined) nulls++;
    else if (typeof v === "string" && v.trim() === "") empty++;
    else filled++;
  }
  return { filled, empty, nulls };
}
