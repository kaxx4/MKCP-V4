/**
 * The daily price-list + GST pull — owner's words, 23-Sep-2026: "The price list
 * page is not manual anymore. Set a daily thing where every evening at 6 p.m.
 * the price list is pulled from Tally, and then it also pulls GST."
 *
 * ── What this covers ───────────────────────────────────────────────────────
 *
 * Both halves go through `/api/tally/sync-price-list?includeGst` — the same
 * `fetchPriceList`/`fetchGstRates` + `syncPriceList`/`syncGstRates` calls
 * `syncMastersOnly` already makes for these two collections (see
 * syncOrchestrator.ts step 7/8), reused rather than re-implemented here. This
 * scheduler is deliberately NOT a masters sync: groups/units/godowns/cost
 * centres/stock items/ledgers are minutes of work this daily job has no reason
 * to repeat — the price list and GST rates alone are ~0.2s together (see
 * tallyPriceList.ts, tallyGstRates.ts headers).
 *
 * ── Modeled on nightlySync.ts, with one deliberate difference ─────────────
 *
 * Same shape: `refuseSharedWrite` gate, poll every 60s rather than one
 * setTimeout to the target hour (robust to sleep/wake and clock drift), a
 * `tally_sync_history` row per run. `shouldRunNow` is IMPORTED from
 * nightlySync.ts rather than re-declared — it is the same rule ("fire once
 * per local day, at/after the configured hour"), and a second copy is a
 * second chance for the two schedules to silently disagree on what "due"
 * means (guardrail G1).
 *
 * The deliberate difference is retry behaviour. nightlySync retries a failed
 * run every 60 seconds forever, which — this brief's own words — "floods
 * tally_sync_history on failure". A price/GST pull failing usually means one
 * thing (Tally is closed), and hammering it every minute for hours produces a
 * `tally_sync_history` table that is mostly noise from one bad evening. So
 * this instead:
 *
 *   · retries with backoff (5 min, 15 min, 45 min) — `BACKOFF_MS`
 *   · gives up after `MAX_ATTEMPTS_PER_DAY` (3) failed attempts, until
 *     tomorrow's tick
 *   · persists its state to a local JSON file (not Supabase — this machine
 *     may be `sandbox`, and the state must survive a restart regardless of
 *     whether Supabase is reachable), so a catch-up run on startup and the
 *     daily attempt budget both survive the app being closed and reopened
 *
 * ── Catch-up ────────────────────────────────────────────────────────────
 *
 * If the machine was off at 18:00 and is opened at, say, 21:00 with no
 * successful run recorded for today, the very first tick after startup fires
 * immediately rather than waiting for tomorrow's 18:00 — `dueForAttempt`
 * makes no distinction between "just turned 18:00" and "it is 21:00 and nothing
 * ran yet today", both read as due. That IS the catch-up rule; there is no
 * separate code path for it.
 *
 * Env:
 *   PRICE_GST_SYNC_ENABLED  "false" to disable         (default enabled)
 *   PRICE_GST_SYNC_HOUR     local hour 0-23 to fire     (default 18 = 6pm)
 *
 * Call once from index.ts inside the app.listen callback.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import ws from "ws";
import { isTallyBusy } from "./tallyBusy.js";
import { postTallySync } from "./localSyncClient.js";
import { resolveSyncCompany } from "./scheduledSyncs.js";
import { supabaseClient } from "./supabaseClient.js";
import { refuseSharedWrite } from "./tallyRole.js";
import { shouldRunNow } from "./nightlySync.js";

// Same WebSocket polyfill used by SupabaseSync / refreshListener / nightlySync.
if (typeof globalThis !== "undefined" && !globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

export const SYNC_TYPE = "price_gst_daily";

let started = false;

const pad2 = (n: number) => String(n).padStart(2, "0");
/** Local calendar day key (YYYY-MM-DD) — same helper nightlySync uses. */
export const dateKey = (d: Date): string => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/**
 * Backoff after a failed attempt, in ms: 5 min, then 15, then 45. Index 0 is
 * the wait AFTER the 1st failure (before the 2nd attempt), and so on.
 * `MAX_ATTEMPTS_PER_DAY` — its length — is the hard ceiling: a price/GST pull
 * failing three times in one evening is Tally being closed for the night, not
 * a transient worth chasing every few minutes until midnight.
 */
export const BACKOFF_MS = [5 * 60_000, 15 * 60_000, 45 * 60_000];
export const MAX_ATTEMPTS_PER_DAY = BACKOFF_MS.length;

/** The whole schedule, as a plain, JSON-serialisable, restart-surviving value. */
export interface DailySyncState {
  /** YYYY-MM-DD of the last run that succeeded, or null if never. */
  lastSuccessDate: string | null;
  /** YYYY-MM-DD this attempt streak belongs to (resets the streak on a new day). */
  attemptDate: string | null;
  /** Failed attempts so far today, 0..MAX_ATTEMPTS_PER_DAY. */
  attempts: number;
  /** Epoch ms of the last attempt (success or fail), or null if never. */
  lastAttemptAt: number | null;
}

export const INITIAL_STATE: DailySyncState = {
  lastSuccessDate: null,
  attemptDate: null,
  attempts: 0,
  lastAttemptAt: null,
};

/**
 * Pure scheduling decision: is an attempt due right now?
 *
 * Three cases, in order:
 *   1. Already succeeded today → never due again today.
 *   2. No attempt yet today (a fresh day, OR a state carried over from a day
 *      this process was not running) → due once the local hour is reached.
 *      This is also the WHOLE of the catch-up rule: a machine opened at 9pm
 *      with nothing recorded for today reads identically to one ticking at
 *      exactly 18:00 — both are "not attempted today, and past the hour".
 *   3. An attempt happened today and failed → due again once its backoff has
 *      elapsed, unless the daily attempt budget is spent.
 *
 * Exported (and free of any I/O) so the schedule can be exercised against
 * fake `Date`s and fake state without a real clock or a real Tally.
 */
export function dueForAttempt(now: Date, state: DailySyncState, hour: number): boolean {
  const today = dateKey(now);
  if (state.lastSuccessDate === today) return false;

  if (state.attemptDate !== today) {
    return now.getHours() >= hour;
  }

  if (state.attempts >= MAX_ATTEMPTS_PER_DAY) return false; // budget spent — wait for tomorrow

  const backoff = BACKOFF_MS[Math.max(0, state.attempts - 1)];
  if (state.lastAttemptAt === null) return true; // defensive: attempted but no timestamp recorded
  return now.getTime() - state.lastAttemptAt >= backoff;
}

/**
 * Pure state transition after one attempt. Exported for the same reason as
 * `dueForAttempt`: the whole retry/backoff/give-up rule should be checkable
 * without a clock.
 */
export function afterAttempt(now: Date, state: DailySyncState, success: boolean): DailySyncState {
  const today = dateKey(now);
  if (success) {
    return { lastSuccessDate: today, attemptDate: today, attempts: 0, lastAttemptAt: now.getTime() };
  }
  const sameStreak = state.attemptDate === today;
  return {
    lastSuccessDate: state.lastSuccessDate,
    attemptDate: today,
    attempts: (sameStreak ? state.attempts : 0) + 1,
    lastAttemptAt: now.getTime(),
  };
}

// ── Local persistence ────────────────────────────────────────────────────
//
// A local file, not a Supabase table: this scheduler must know "did I already
// run today" and "how many times have I tried" across a restart even on a
// machine where Supabase writes are refused (MKCP_TALLY_ROLE=sandbox), and
// even during a Supabase outage on the machine that is allowed to write. Same
// reasoning as tallyLog.ts's JSONL — diagnostic/scheduling state does not
// belong in the shared mirror, and must not depend on it being reachable.

function defaultStatePath(): string {
  return join(process.cwd(), "server", "data", "price-gst-sync-state.json");
}

let statePathOverride: string | null = null;

/** Test-only hook so the scheduling test can use a throwaway file. */
export function configureStatePath(path: string | null): void {
  statePathOverride = path;
}

export function loadState(): DailySyncState {
  const path = statePathOverride ?? defaultStatePath();
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return {
      lastSuccessDate: typeof raw.lastSuccessDate === "string" ? raw.lastSuccessDate : null,
      attemptDate: typeof raw.attemptDate === "string" ? raw.attemptDate : null,
      attempts: Number.isFinite(raw.attempts) ? raw.attempts : 0,
      lastAttemptAt: Number.isFinite(raw.lastAttemptAt) ? raw.lastAttemptAt : null,
    };
  } catch {
    return { ...INITIAL_STATE };
  }
}

export function saveState(state: DailySyncState): void {
  const path = statePathOverride ?? defaultStatePath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state), "utf8");
  } catch (e: any) {
    console.warn(`📅 [PRICE-GST] Could not persist schedule state: ${e.message}`);
  }
}

/**
 * Schedules the daily price-list + GST pull at a fixed local hour (default
 * 18:00). POSTs the same guarded `/api/tally/sync-price-list` endpoint the
 * web dashboard's "refresh price list" button uses, with `includeGst: true`,
 * so `syncGuard` serialises it with every other sync and the Supabase upload
 * happens exactly the way a manual pull's does.
 *
 * Call once from index.ts inside the app.listen callback.
 */
export function startPriceGstDailySync(localPort: number, fallbackCompany: string): void {
  if (started) return;
  if ((process.env.PRICE_GST_SYNC_ENABLED ?? "true").toLowerCase() === "false") {
    console.log("📅 [PRICE-GST] Disabled (PRICE_GST_SYNC_ENABLED=false)");
    return;
  }
  /* A duplicate company has nothing to mirror — see nightlySync.ts / tallyRole.ts. */
  if (refuseSharedWrite("Daily price/GST sync")) return;
  started = true;

  const hourRaw = parseInt(process.env.PRICE_GST_SYNC_HOUR ?? "18", 10);
  const hour = Number.isFinite(hourRaw) ? Math.min(23, Math.max(0, hourRaw)) : 18;

  const supabase = supabaseClient();
  const resolveCompany = () => resolveSyncCompany(fallbackCompany);

  const logRun = async (
    company: string,
    success: boolean,
    startedAt: string,
    durationMs: number,
    rowCounts: Record<string, unknown> | null,
    errors: string[] | null,
  ) => {
    if (!supabase) return;
    try {
      const { error } = await supabase.from("tally_sync_history").insert({
        company,
        sync_type: SYNC_TYPE,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        row_counts: rowCounts,
        errors,
        success,
        duration_ms: durationMs,
      });
      if (error) console.error(`📅 [PRICE-GST] Failed to log run: ${error.message}`);
    } catch (e: any) {
      console.error(`📅 [PRICE-GST] Failed to log run: ${e.message}`);
    }
  };

  const fire = async (): Promise<"ok" | "busy" | "failed"> => {
    const company = await resolveCompany();
    const startedAt = new Date().toISOString();
    const t0 = Date.now();

    console.log("");
    console.log("📅 ──────────────────────────────────────────────────────");
    console.log("📅 [PRICE-GST] Daily price list + GST pull (scheduled)");
    console.log(`📅 [PRICE-GST]   • company : ${company}`);
    console.log("📅 ──────────────────────────────────────────────────────");

    try {
      const resp = await postTallySync(
        localPort,
        { company, origin: "scheduled-price-gst-daily", includeGst: true },
        "/api/tally/sync-price-list",
      );

      if (resp.ok) {
        const result: any = resp.json;
        if (result && result.success === false) {
          const msg = result.error || "Tally returned zero price rows — check Tally is open";
          console.error(`📅 [PRICE-GST] ✗ No data: ${msg}`);
          await logRun(company, false, startedAt, Date.now() - t0, null, [msg]);
          return "failed";
        }
        console.log(
          `📅 [PRICE-GST] ✓ Completed: ${result?.count ?? 0} price rows, ${result?.items ?? 0} items` +
            (result?.gst ? `, ${result.gst.rows} GST rates` : result?.gstError ? ` (GST failed: ${result.gstError})` : "") +
            ` in ${Date.now() - t0}ms`,
        );
        // A GST-fetch failure does not fail the whole run — the price list is
        // the half the owner asked for first and it landed; the route reports
        // gstError separately so it is visible here and in the history row,
        // without discarding a good price pull over it.
        await logRun(
          company,
          true,
          startedAt,
          Date.now() - t0,
          { priceRows: result?.count ?? 0, items: result?.items ?? 0, gstRows: result?.gst?.rows ?? null },
          result?.gstError ? [`GST rates: ${result.gstError}`] : null,
        );
        return "ok";
      } else if (resp.status === 409) {
        // Another sync already holds the lock — not a failure of this job;
        // today's price/GST data still gets refreshed by whichever sync is
        // holding it, or by the next 60s tick. No history row and no attempt
        // consumed: a busy port is not an outcome worth a row or a strike
        // against the daily budget, it is nothing having happened yet.
        console.log("📅 [PRICE-GST] ⏭ Skipped — a sync was already running; will retry shortly");
        return "busy";
      } else {
        throw new Error(`HTTP ${resp.status}`);
      }
    } catch (err: any) {
      console.error(`📅 [PRICE-GST] ✗ Failed: ${err.message}`);
      await logRun(company, false, startedAt, Date.now() - t0, null, [err.message]);
      return "failed";
    }
  };

  let state = loadState();
  console.log(
    `📅 [PRICE-GST] Scheduled daily price list + GST pull at ${pad2(hour)}:00 local ` +
      `(checking every 60s; last success: ${state.lastSuccessDate ?? "never"})`,
  );

  let busyLogged = false;
  const tick = () => {
    const now = new Date();
    if (!dueForAttempt(now, state, hour)) return;

    // Tally's XML port is single-threaded — see nightlySync.ts. A busy tick
    // is deferred WITHOUT counting as a failed attempt: it says nothing about
    // whether the pull itself would have worked.
    if (isTallyBusy()) {
      if (!busyLogged) {
        console.log("📅 [PRICE-GST] Tally busy with another sync — deferring, will retry each minute");
        busyLogged = true;
      }
      return;
    }
    busyLogged = false;

    void fire().then((outcome) => {
      if (outcome === "busy") return; // no state change — see fire()'s 409 branch
      state = afterAttempt(now, state, outcome === "ok");
      saveState(state);
      if (outcome === "failed" && state.attempts >= MAX_ATTEMPTS_PER_DAY) {
        console.error(
          `📅 [PRICE-GST] ✗ Gave up after ${MAX_ATTEMPTS_PER_DAY} failed attempts today — will try again at ${pad2(hour)}:00 tomorrow`,
        );
      }
    });
  };

  setInterval(tick, 60_000);
}
