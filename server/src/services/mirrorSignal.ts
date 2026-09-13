/**
 * Tell the clients WHICH rows moved, not just that something did.
 *
 * ── What this replaces ────────────────────────────────────────────────────
 *
 * The agent inserts one row into `tally_sync_history`, and every open browser
 * reloads five tables — 2,792 vouchers, 8,703 ledger entries, 11,924 inventory
 * entries — plus a transform/index/margins pass. Measured: ~2.4 s of network per
 * reload. The agent writes 150-220 rows on a normal day, so even with 20 s
 * coalescing that is roughly 17 full reloads a session (280 in the worst one
 * recorded) to learn that one voucher moved.
 *
 * ── The rule that makes this safe ─────────────────────────────────────────
 *
 * A signal is a HINT, never a source of truth. Every consumer must be able to
 * ignore it and reload instead, and this module is written so that is always
 * the correct fallback:
 *
 *   · a failed signal write is swallowed — the sync itself must not fail
 *     because an optimisation could not be published;
 *   · a signal is emitted AFTER the row is committed, never before, so a client
 *     that reacts instantly cannot read a row that is not there yet;
 *   · above a threshold, no per-row signals are emitted at all. A full sync
 *     rewrites every voucher, and 2,792 individual signals would be slower for
 *     everyone than the single reload they were meant to avoid.
 *
 * The worst case a bug here can produce is a client doing exactly what it does
 * today. That is the property worth protecting.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Above this many changed rows, stay silent and let the reload happen.
 *
 * Chosen from the measured shapes rather than a round number: a day's real
 * trading is ~17 vouchers and the busiest hour writes a few hundred rows, while
 * a full sync rewrites 2,792. So a few hundred signals is the useful band, and
 * anything past it is a rebuild that a single reload handles better.
 */
export const SIGNAL_CEILING = 300;

export type MirrorOp = "insert" | "update" | "delete";

export interface MirrorChange {
  table: string;
  pk: string;
  op: MirrorOp;
  /** Tally's ALTERID where there is one, so a client can order two signals. */
  version?: number | null;
}

export interface SignalOutcome {
  emitted: number;
  /** True when the ceiling was hit and clients should expect a full reload. */
  suppressed: boolean;
  note: string;
}

/**
 * Publish a batch of changes.
 *
 * Never throws. A caller must be able to write this line into a sync path
 * without wrapping it, because a sync that fails for want of a hint is strictly
 * worse than a client that reloads.
 */
export async function emitMirrorChanges(
  sb: SupabaseClient | null,
  company: string,
  changes: MirrorChange[],
): Promise<SignalOutcome> {
  if (!sb || changes.length === 0) {
    return { emitted: 0, suppressed: false, note: "nothing to publish" };
  }

  if (changes.length > SIGNAL_CEILING) {
    /* Deliberately silent. Clients still get the tally_sync_history row and do
       what they do today; emitting 2,792 signals would cost more than the
       reload it was meant to replace. Said out loud in the return value so a
       caller logging this can tell "suppressed" from "failed". */
    return {
      emitted: 0,
      suppressed: true,
      note: `${changes.length} changes exceeds the ${SIGNAL_CEILING} ceiling — left to the full-reload path, which handles a rebuild better than per-row patches would`,
    };
  }

  const rows = changes.map((c) => ({
    company,
    table_name: c.table,
    pk: c.pk,
    op: c.op,
    version: c.version ?? null,
  }));

  try {
    const { error } = await sb.from("mirror_change_signal").insert(rows);
    if (error) {
      return { emitted: 0, suppressed: false, note: `signal insert failed (harmless): ${error.message}` };
    }
    return { emitted: rows.length, suppressed: false, note: `${rows.length} change(s) published` };
  } catch (e: any) {
    // Swallowed on purpose — see the header.
    return { emitted: 0, suppressed: false, note: `signal insert threw (harmless): ${e?.message ?? e}` };
  }
}

/**
 * Delete hints older than a day.
 *
 * They are worthless past every client's fallback window, and an append-only
 * table nobody prunes becomes the next thing someone has to discover.
 */
export async function pruneMirrorSignals(sb: SupabaseClient | null, olderThanHours = 24): Promise<number> {
  if (!sb) return 0;
  const cutoff = new Date(Date.now() - olderThanHours * 3_600_000).toISOString();
  try {
    const { data } = await sb.from("mirror_change_signal").delete().lt("created_at", cutoff).select("id");
    return data?.length ?? 0;
  } catch {
    return 0;
  }
}
