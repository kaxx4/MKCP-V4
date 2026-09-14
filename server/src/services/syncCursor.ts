/**
 * Where incremental sync resumes from, and why that is the mirror and not Tally.
 *
 * ── The bug this removes ──────────────────────────────────────────────────
 *
 * `RealtimeSync.start()` seeded its cursor with `fetchCurrentAlterIds()` —
 * Tally's high-water mark AT THIS MOMENT. The comment explained it as avoiding
 * a first tick that reports every voucher as changed, which is a real concern
 * and the wrong fix.
 *
 * The consequence: every restart silently declares "everything up to now has
 * been seen". Anything edited while the agent was down — overnight, over a
 * weekend, during an update — is above the OLD cursor and below the NEW one,
 * so it is never re-read. It does not error. It does not log. The mirror is
 * simply, permanently, wrong about those vouchers.
 *
 * That was unavoidable while the cursor lived only in memory. It is not any
 * more: `tally_vouchers.alter_id` (migration 029) makes the mirror able to
 * answer "what is the highest AlterID I have actually stored", which is the
 * real definition of where to resume.
 *
 * ── The fallback, and why it is announced ─────────────────────────────────
 *
 * When the mirror holds no alter_id at all — a fresh install, or rows synced
 * before 029 — there is no durable answer and Tally's current mark is the only
 * available baseline. That case is REPORTED rather than assumed, because it is
 * exactly the case where changes can be missed, and a cursor that cannot say
 * how it was derived is how this went unnoticed for months.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type CursorSource = "mirror" | "tally-now" | "zero";

export interface CursorOrigin {
  value: number;
  source: CursorSource;
  /** One line a human can act on. */
  note: string;
}

/**
 * The highest voucher AlterID the mirror actually holds for this company.
 *
 * Returns null — not 0 — when the mirror cannot answer. Zero would mean "start
 * from the beginning", which is a completely different instruction from "I do
 * not know", and conflating the two is what a caller must not be allowed to do.
 */
export async function mirrorVoucherWatermark(
  sb: SupabaseClient | null, company: string,
): Promise<number | null> {
  if (!sb) return null;
  const { data, error } = await sb
    .from("tally_vouchers")
    .select("alter_id")
    .eq("company", company)
    .not("alter_id", "is", null)
    .order("alter_id", { ascending: false })
    .limit(1);
  if (error) return null;
  const top = data?.[0]?.alter_id;
  return typeof top === "number" && top > 0 ? top : null;
}

/**
 * Decide the resume point, and say where it came from.
 *
 * `tallyNow` is the caller's expensive full-sweep result, passed in rather than
 * fetched here so this stays testable and so the sweep is not paid for twice.
 */
export function resolveVoucherCursor(
  fromMirror: number | null, tallyNow: number,
): CursorOrigin {
  if (fromMirror !== null) {
    const behind = tallyNow - fromMirror;
    return {
      value: fromMirror,
      source: "mirror",
      note: behind > 0
        ? `resuming from the mirror's watermark ${fromMirror}; Tally is at ${tallyNow}, so ${behind} AlterID(s) happened while this agent was not watching and will now be picked up`
        : `resuming from the mirror's watermark ${fromMirror}; level with Tally`,
    };
  }
  if (tallyNow > 0) {
    return {
      value: tallyNow,
      source: "tally-now",
      note: `the mirror holds no alter_id, so there is no durable resume point. ` +
        `Starting from Tally's current mark ${tallyNow} — anything edited before now will NOT be re-read. ` +
        `Run a full sync to populate alter_id, after which restarts resume correctly.`,
    };
  }
  return {
    value: 0,
    source: "zero",
    note: `neither the mirror nor Tally reports an AlterID. Starting from zero; the first ` +
      `voucher check will look like a full sweep, which is correct for an empty mirror.`,
  };
}
