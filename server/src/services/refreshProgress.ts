/**
 * Writes "how far along" onto the web's "Sync now" request rows while a sync runs (H-1, 19-Nov-2026), so Home can draw a real
 * progress bar instead of a spinner: days done, days in all, and the day just finished.
 *
 * Only the "days-done" event counts (the orchestrator sends it after each wave of daily chunks finishes). Writes are throttled to
 * one every THROTTLE_MS so a 230-day full-year pull costs about 80 small updates, not 230; the last value is always written by
 * flush(). Any failure is ignored: progress is a nicety and must never fail a sync. Columns come from migration 0339; on a database
 * without them the update errors and is ignored the same way.
 */
import type { SyncProgress } from "../types.js";
import { supabaseClient } from "./supabaseClient.js";

export const THROTTLE_MS = 3_000;

export interface ProgressRow { progress_done: number; progress_total: number; progress_label: string; progress_at: string }
export type ProgressSink = (ids: number[], row: ProgressRow) => Promise<void>;

const defaultSink: ProgressSink = async (ids, row) => {
  const db = supabaseClient();
  if (!db) return;
  try { await db.from("tally_refresh_commands").update(row).in("id", ids); } catch { /* progress is best effort */ }
};

/** The ids the web sent, cleaned. Anything that is not a positive whole number is dropped. */
export function cleanIds(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  return Array.from(new Set(raw.map(Number).filter((n) => Number.isInteger(n) && n > 0)));
}

export function refreshProgressWriter(rawIds: unknown, sink: ProgressSink = defaultSink, now: () => number = Date.now) {
  const ids = cleanIds(rawIds);
  let pending: ProgressRow | null = null;
  let lastWrite = 0;
  let inFlight: Promise<void> = Promise.resolve();

  const write = (row: ProgressRow) => {
    lastWrite = now();
    pending = null;
    inFlight = inFlight.then(() => sink(ids, row)).catch(() => undefined);
  };

  return {
    onProgress(p: SyncProgress): void {
      if (ids.length === 0 || p.phase !== "days-done") return;
      const row: ProgressRow = {
        progress_done: Math.max(0, Math.min(p.step, p.totalSteps)),
        progress_total: Math.max(0, p.totalSteps),
        progress_label: String(p.detail ?? "").slice(0, 80),
        progress_at: new Date(now()).toISOString(),
      };
      if (now() - lastWrite >= THROTTLE_MS || row.progress_done === row.progress_total) write(row);
      else pending = row;
    },
    /** Write whatever is still held back, and wait for every write to finish. */
    async flush(): Promise<void> {
      if (pending) write(pending);
      await inFlight;
    },
  };
}
