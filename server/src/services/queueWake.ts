/**
 * JOB: tell the office agent's queue loop at once when an ERP job is created or changes, so a pushed bill starts working in about a second instead
 * of waiting out the 30 s poll (speed pass S3, 28-Nov-2026).
 *
 * Why it is safe to add: it asks for nothing and writes nothing. The database already writes one payload-free row to `erp_change_signals` for every
 * change to `erp_jobs` (migration 0124, `erp_signal_batch`, a trigger on that table; the table is in the realtime publication). This listens for
 * those rows and calls `PrimaryQueueLoop.wake()`, which runs the SAME round the poll would have run (same lease, same company pin, same claim).
 * Nothing about who may claim, or whether `live_claims` is on, changes; the wake only moves the moment of the next look.
 *
 * If the socket never connects, drops, or the signal never arrives, the 30 s poll carries on exactly as before: this can make a round earlier,
 * never remove one. It does not add database reads while idle (the poll the owner slowed on 18-Nov-2026, lane agent-poll, stays at 30 s).
 *
 * Measured before (28-Nov-2026, live `erp_jobs`, jobs approved by the person who made them): created to succeeded took 25 s at best and a median
 * of 100 s (split sale) to 145 s (purchase). The 30 s idle poll is the part this removes; the rest is the work itself (one push, one read-back,
 * one at a time) and the queue ahead of a job.
 *
 * Never used by a sandbox: `supabaseClient()` returns null there. The latency rig `scripts/rigs/realtime-signals-live.ts` measures how fast a
 * signal arrives; this file only listens for the same kind of row.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseClient } from "./supabaseClient.js";
import { reconnectDelayMs, shouldReconnect } from "./refreshListener.js";

/** The table name a job signal carries (what `erp_signal_batch` writes for the trigger on erp_jobs). */
export const JOB_SIGNAL_TABLE = "erp_jobs";

/** Pure: is this realtime payload the signal of a job change? Anything else (another table's signal, a malformed payload) is ignored. */
export function isJobSignal(payload: unknown): boolean {
  const row = (payload as { new?: { table_name?: unknown } } | null | undefined)?.new;
  return !!row && row.table_name === JOB_SIGNAL_TABLE;
}

export interface QueueWakeHandle { stop(): void }

/**
 * Subscribe and wake. Returns null when this process has no database client (offline, sandbox, no key).
 * `client` is for tests; the real call leaves it out.
 */
export function startQueueWake(o: { wake: () => unknown; log?: (l: string) => void; client?: SupabaseClient | null }): QueueWakeHandle | null {
  const log = o.log ?? ((l: string) => console.log(l));
  let client: SupabaseClient | null;
  try { client = o.client !== undefined ? o.client : supabaseClient({ realtime: { params: { eventsPerSecond: 2 } } }); } catch { client = null; }
  if (!client) return null;
  const sb = client;
  let stopped = false;
  let channel: ReturnType<SupabaseClient["channel"]> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const open = (attempt: number): void => {
    if (stopped) return;
    let retired = false;
    const ch = sb
      .channel(`queue-wake-${Math.random().toString(36).slice(2, 8)}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "erp_change_signals", filter: `table_name=eq.${JOB_SIGNAL_TABLE}` },
        (payload) => { if (isJobSignal(payload)) { try { o.wake(); } catch { /* a wake never fails the listener */ } } },
      )
      .subscribe((status, err) => {
        if (status === "SUBSCRIBED") {
          attempt = 0;
          log(`listening for new jobs (the queue starts at once when one is created)`);
          /* A job created while the socket was down announced itself to nobody: look once now. */
          try { o.wake(); } catch { /* ignore */ }
        } else if (shouldReconnect(status, retired) && !stopped) {
          retired = true;
          const delay = reconnectDelayMs(attempt);
          log(`the new-job signal channel is ${status}${err ? ` (${err.message})` : ""}; the 30 s poll carries on, trying to listen again in ${delay / 1000} s`);
          void sb.removeChannel(ch);
          retryTimer = setTimeout(() => open(attempt + 1), delay);
          retryTimer.unref?.();
        }
      });
    channel = ch;
  };
  open(0);

  return {
    stop: () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (channel) void sb.removeChannel(channel);
    },
  };
}
