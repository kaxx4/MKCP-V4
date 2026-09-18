/**
 * Prune the append-only tables, so nobody has to discover them later.
 *
 * ── The thing this stops happening again ──────────────────────────────────
 *
 * `pruneMirrorSignals` has existed since the mirror-signal work, does exactly
 * the right thing, and had ZERO callers. Its own comment says why that matters:
 *
 *   "an append-only table nobody prunes becomes the next thing someone has to
 *    discover."
 *
 * It was, on 18-Sep-2026. `perf_logs` had reached **200 MB across 555,669
 * rows** — four times the entire business dataset, every Tally table put
 * together being about 45 MB — growing at roughly 7,200 rows a day with
 * nothing removing any of it. Trimming to thirty days and vacuuming took it to
 * 37 MB. `mirror_change_signal` was on the same path, 15,250 rows in four days.
 *
 * A one-off cleanup fixes a number. This fixes the shape.
 *
 * ── Why here and not in scheduledSyncs ───────────────────────────────────
 *
 * `startScheduledSyncs` is opt-in behind `SCHEDULED_SYNC_ENABLED`, which is
 * deliberately off on every machine but the one holding the real books. Pruning
 * has none of that risk and needs to happen wherever the agent runs, so it gets
 * its own timer rather than riding on a flag that is usually false.
 *
 * ── What it will not do ──────────────────────────────────────────────────
 *
 * Nothing on a sandbox. A copy of the company shares the mirror with the real
 * one, and although deleting old telemetry is harmless, "the sandbox does not
 * write to the shared database" is a rule worth keeping whole — an exception
 * is how the next person justifies the one that matters.
 */
import { supabaseClient } from "./supabaseClient.js";
import { refuseSharedWrite } from "./tallyRole.js";
import { pruneMirrorSignals } from "./mirrorSignal.js";

/** Telemetry worth keeping. Long enough to compare a bad week to a normal one. */
const PERF_LOG_DAYS = 30;

/** Change hints are worthless past every client's fallback window. */
const SIGNAL_HOURS = 24;

/** Once a day. The first pass is delayed so boot is not competing with it. */
const EVERY_MS = 24 * 60 * 60 * 1000;
const FIRST_RUN_MS = 5 * 60 * 1000;

let started = false;

async function runOnce(): Promise<void> {
  const sb = supabaseClient();
  if (!sb) return;

  const signals = await pruneMirrorSignals(sb, SIGNAL_HOURS);

  let perf = 0;
  try {
    const cutoff = new Date(Date.now() - PERF_LOG_DAYS * 86_400_000).toISOString();
    /* `.select("id")` so the count is what was REMOVED rather than what the
       statement was willing to attempt — the same reason the mirror-year reset
       had to start doing this. A delete that removes nothing and reports
       success is indistinguishable from one that worked. */
    const { data, error } = await sb.from("perf_logs").delete().lt("created_at", cutoff).select("id");
    if (error) throw new Error(error.message);
    perf = data?.length ?? 0;
  } catch (e) {
    console.warn(`🧹 [housekeeping] perf_logs prune failed: ${(e as Error).message}`);
  }

  if (signals || perf) {
    console.log(`🧹 [housekeeping] pruned ${signals} change signal(s), ${perf} perf log(s)`);
  }
}

/** Call once from index.ts. */
export function startHousekeeping(): void {
  if (started) return;
  if (refuseSharedWrite("Housekeeping")) return;
  started = true;

  setTimeout(() => void runOnce(), FIRST_RUN_MS).unref?.();
  setInterval(() => void runOnce(), EVERY_MS).unref?.();
  console.log(`🧹 [housekeeping] on — perf_logs kept ${PERF_LOG_DAYS}d, change signals ${SIGNAL_HOURS}h`);
}
