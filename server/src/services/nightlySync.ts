import { createClient } from "@supabase/supabase-js";
import ws from "ws";
import { isTallyBusy } from "./tallyBusy.js";
import { postTallySync } from "./localSyncClient.js";

// Same WebSocket polyfill used by SupabaseSync / refreshListener.
if (typeof globalThis !== "undefined" && !globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

let started = false;

const pad2 = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
/** Local calendar day key (YYYY-MM-DD) — used to fire at most once per day. */
const dateKey = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/** Current financial year (Apr 1 → today) as YYYYMMDD. Mirrors refreshListener. */
function currentFyRange(): { from: string; to: string } {
  const now = new Date();
  const fyStartYear = now.getMonth() < 3 ? now.getFullYear() - 1 : now.getFullYear();
  return { from: `${fyStartYear}0401`, to: ymd(now) };
}

/**
 * Pure decision: should the nightly sync fire on this tick?
 * Fires once per local calendar day, at/after the configured hour, and never on
 * the same day it last ran. Exported so the scheduling rule can be unit-tested
 * without waiting for a real midnight.
 */
export function shouldRunNow(now: Date, lastRunDate: string, hour: number): boolean {
  return dateKey(now) !== lastRunDate && now.getHours() >= hour;
}

/**
 * Schedules an automatic full-FY Tally sync every night at a fixed local hour
 * (default 00:00). It POSTs the same guarded /api/tally/sync endpoint the desktop
 * UI and the web-refresh listener use, so syncGuard serialises it with any other
 * sync and the orchestrator uploads to Supabase exactly as normal.
 *
 * Robust to long-timer drift and sleep/wake: instead of one setTimeout to
 * midnight, it polls every 60 s and fires on the first tick of a new local day.
 *
 * Env:
 *   NIGHTLY_SYNC_ENABLED  "false" to disable       (default enabled)
 *   NIGHTLY_SYNC_HOUR     local hour 0-23 to fire  (default 0 = midnight)
 *   NIGHTLY_SYNC_RUN_NOW  "true" to also fire once ~10 s after startup (ops/test)
 *
 * Call once from index.ts inside the app.listen callback.
 */
export function startNightlySync(localPort: number, fallbackCompany: string): void {
  if (started) return;
  if ((process.env.NIGHTLY_SYNC_ENABLED ?? "true").toLowerCase() === "false") {
    console.log("🌙 [NIGHTLY] Disabled (NIGHTLY_SYNC_ENABLED=false)");
    return;
  }
  started = true;

  const hourRaw = parseInt(process.env.NIGHTLY_SYNC_HOUR ?? "0", 10);
  const hour = Number.isFinite(hourRaw) ? Math.min(23, Math.max(0, hourRaw)) : 0;

  // Company resolution reuses the same source of truth the web/refreshListener
  // uses (tally_companies.name). We only build a client if a service key is
  // present in the env (electron.js sets it in packaged builds); otherwise we
  // fall back to the literal — no third hardcoded secret.
  const url = process.env.SUPABASE_URL || "https://vmkytsytxlofjyeotmgb.supabase.co";
  const key = process.env.SUPABASE_SERVICE_KEY;
  const supabase = key ? createClient(url, key) : null;

  const resolveCompany = async (): Promise<string> => {
    if (!supabase) return fallbackCompany;
    try {
      const { data, error } = await supabase
        .from("tally_companies")
        .select("name")
        .order("synced_at", { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle();
      if (!error && data?.name) return data.name as string;
    } catch {
      /* fall through to fallback */
    }
    return fallbackCompany;
  };

  // Best-effort failure marker, separate from the per-syncType rows the
  // orchestrator itself writes (masters/vouchers, keyed off internal `errors`
  // arrays, not the overall result.success/thrown-exception cases below). This
  // is the row a human actually needs: "the nightly job didn't complete". The
  // web dashboard's FreshnessChip reads tally_sync_history to warn when data is
  // stale, so this row is what makes a broken nightly run visible there instead
  // of only in this process's console.
  const logNightlyFailure = async (company: string, message: string) => {
    if (!supabase) return;
    try {
      const now = new Date().toISOString();
      const { error } = await supabase.from("tally_sync_history").insert({
        company,
        sync_type: "nightly",
        started_at: now,
        completed_at: now,
        row_counts: null,
        errors: [message],
        success: false,
        duration_ms: 0,
      });
      if (error) console.error(`🌙 [NIGHTLY] Failed to log failure row: ${error.message}`);
    } catch (e: any) {
      console.error(`🌙 [NIGHTLY] Failed to log failure row: ${e.message}`);
    }
  };

  const fire = async (): Promise<boolean> => {
    const company = await resolveCompany();
    const { from, to } = currentFyRange();

    console.log("");
    console.log("🌙 ──────────────────────────────────────────────────────");
    console.log("🌙 [NIGHTLY] Automatic full-FY sync (scheduled)");
    console.log(`🌙 [NIGHTLY]   • company : ${company}`);
    console.log(`🌙 [NIGHTLY]   • range   : ${from} → ${to}  (full FY, daily chunks)`);
    console.log("🌙 ──────────────────────────────────────────────────────");

    try {
      // Uses Node's http client (not fetch) so the ~90-min full-FY sync isn't
      // aborted by undici's 5-min headersTimeout. See localSyncClient.ts.
      const resp = await postTallySync(localPort, {
        company,
        fromDate: from,
        toDate: to,
        mode: "full",
        chunkStrategy: "daily",
      });

      if (resp.ok) {
        const result: any = resp.json;
        if (result && result.success === false) {
          const msg = result.error || "Tally returned zero rows — check Tally is open";
          console.error(`🌙 [NIGHTLY] ✗ No data: ${msg}`);
          await logNightlyFailure(company, msg);
          return false;
        } else {
          const s = result?.stats;
          console.log(
            s
              ? `🌙 [NIGHTLY] ✓ Completed: ${s.vouchers ?? 0} vouchers, ${s.stockItems ?? 0} items, ` +
                  `${s.ledgers ?? 0} ledgers in ${s.elapsedSeconds ?? "?"}s`
              : "🌙 [NIGHTLY] ✓ Completed"
          );
          return true;
        }
      } else if (resp.status === 409) {
        // Another sync already had the lock — not a failure of the nightly job
        // itself, so no failure row and no retry-tomorrow: today's data still
        // gets refreshed by whichever sync is holding the lock.
        console.log("🌙 [NIGHTLY] ⏭ Skipped — a sync was already running; data refreshes from that run");
        return true;
      } else {
        throw new Error(`HTTP ${resp.status}`);
      }
    } catch (err: any) {
      console.error(`🌙 [NIGHTLY] ✗ Failed: ${err.message}`);
      await logNightlyFailure(company, err.message);
      return false;
    }
  };

  // Treat today's slot as already handled so we don't fire a heavy sync every
  // time the app is opened mid-day. First real run is at HOUR:00 on the next day.
  let lastRunDate = dateKey(new Date());

  let deferLogged = false;
  const tick = () => {
    const now = new Date();
    if (!shouldRunNow(now, lastRunDate, hour)) return;
    // Tally's XML port is single-threaded. If another sync (e.g. the renderer's
    // 30-min "Today" sync, or a web refresh) is already running, don't pile on —
    // skip this tick without marking the day done, so we retry in 60s and fire as
    // soon as Tally is free.
    if (isTallyBusy()) {
      if (!deferLogged) {
        console.log("🌙 [NIGHTLY] Tally busy with another sync — deferring, will retry each minute");
        deferLogged = true;
      }
      return;
    }
    deferLogged = false;
    // Only mark today done on success. On failure, leave lastRunDate unset so
    // the next 60s tick retries — same deferral behavior as the isTallyBusy()
    // check above, just triggered by a failed attempt instead of a busy port.
    void fire().then((ok) => {
      if (ok) lastRunDate = dateKey(now);
    });
  };

  setInterval(tick, 60_000);
  console.log(
    `🌙 [NIGHTLY] Scheduled automatic full-FY sync at ${pad2(hour)}:00 local (checking every 60s)`
  );

  if ((process.env.NIGHTLY_SYNC_RUN_NOW ?? "").toLowerCase() === "true") {
    console.log("🌙 [NIGHTLY] NIGHTLY_SYNC_RUN_NOW=true — firing one full-FY sync shortly…");
    setTimeout(() => void fire(), 10_000);
  }
}
