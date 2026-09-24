import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import ws from "ws";
import { postTallySync } from "./localSyncClient.js";
import { supabaseClient } from "./supabaseClient.js";
import { refuseSharedWrite } from "./tallyRole.js";

// Same WebSocket polyfill used by SupabaseSync
if (typeof globalThis !== "undefined" && !globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

let started = false;

const pad2 = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;

/** Current financial year (Apr 1 → today) as YYYYMMDD. Matches the desktop FY. */
function currentFyRange(): { from: string; to: string } {
  const now = new Date();
  // FY starts 1 April; before April we're still in last year's FY.
  const fyStartYear = now.getMonth() < 3 ? now.getFullYear() - 1 : now.getFullYear();
  return { from: `${fyStartYear}0401`, to: ymd(now) };
}

/** Trailing-N-days window (today − n → today) as YYYYMMDD. */
function lastNDaysRange(n: number): { from: string; to: string } {
  const now = new Date();
  const start = new Date(now);
  start.setDate(start.getDate() - n);
  return { from: ymd(start), to: ymd(now) };
}

/** Resolve the sync window from a command row's `days` column.
 *  null/undefined → full current FY; 0 → today only; positive int → trailing N days. */
function rangeForDays(days: unknown): { from: string; to: string; label: string } {
  if (days === null || days === undefined) return { ...currentFyRange(), label: "full FY" };
  const n = typeof days === "number" && Number.isFinite(days) ? Math.floor(days) : -1;
  if (n < 0) return { ...currentFyRange(), label: "full FY" }; // non-numeric → safe default
  if (n === 0) { const t = ymd(new Date()); return { from: t, to: t, label: "today" }; }
  return { ...lastNDaysRange(n), label: `last ${n} days` };
}

/** Rank a `days` scope by width so a burst can be coalesced to the WIDEST one, which
 *  supersets every narrower trailing window: full FY (null) > larger N > 7 > 0 (today). */
function rankDays(days: unknown): number {
  if (days === null || days === undefined) return Infinity;
  return typeof days === "number" && Number.isFinite(days) && days >= 0 ? days : Infinity;
}

/** Short human label for a `days` value, for log lines. */
function fmtDays(days: unknown): string {
  if (days === null || days === undefined) return "full FY";
  if (days === 0) return "today";
  return typeof days === "number" ? `last ${days}d` : "full FY";
}

// How long a `pending`/`ack` command can sit unresolved before we treat it as
// dead (desktop crashed mid-sync in a prior session) and sweep it to "error"
// on the next startup. Set comfortably above the worst-case full-FY sync
// (~90 min, see the AbortController timeout in src/api/tallyApi.ts) so we
// never mis-mark a genuinely still-running sync from a previous process.
const STALE_MS = 2 * 60 * 60 * 1000; // 2 hours

// How often we re-check `tally_companies.name` and, if it changed (e.g. an
// FY-rollover rename happening while this process stays up), tear down the
// old Realtime subscription and resubscribe under the new name. Resolving
// once at startup only survives renames across app *restarts* — this closes
// the same-session gap.
const COMPANY_RECHECK_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Subscribes to `tally_refresh_commands` via Supabase Realtime.
 * When the web dashboard inserts a row for this company, we:
 *   1. Immediately update status → "ack" so the web button gets feedback.
 *   2. POST to our own /api/tally/sync endpoint (the same path the desktop
 *      UI uses) so the existing syncGuard, orchestrator, and Supabase upload
 *      all run normally.
 *   3. On completion, set status → "done" (or "error" on failure / no data).
 *
 * The company we listen for is resolved from `tally_companies.name` — the SAME
 * source the web dashboard's useCompany() reads — so the Realtime filter is
 * guaranteed to match what the web inserts into tally_refresh_commands.company.
 * It's re-checked every COMPANY_RECHECK_MS so a rename (e.g. the FY-rollover
 * "- (from 1-Apr-26)" suffix) is picked up even mid-session, not just across
 * app restarts. `fallbackCompany` (the TALLY_COMPANY env / literal) is used
 * only if the lookup returns nothing.
 *
 * Call once from index.ts inside the app.listen callback.
 */
export function startRefreshListener(localPort: number, fallbackCompany: string): void {
  if (started) return;
  started = true;

  /* A sandbox must not serve this. Second layer, said out loud.
     This was ALREADY safe: `supabaseClient()` returns null on a sandbox and
     the call below bails on it, so a copy never subscribed. What it did not do
     was SAY so — the refusal looked identical to "no service key configured",
     and this is the path a person triggers, the web dashboard's "refresh now".
     Refusing here names the machine and the reason in the boot log, next to
     the other six, so which machine is serving refreshes is never inferred
     from an absence. It is not what makes this safe; it is what makes it
     legible. */
  if (refuseSharedWrite("Remote refresh listener")) return;

  // Service-role key must come from the env — no hardcoded fallback. A
  // literal key used to sit here (and in supabaseSync.ts's constructor) and
  // was committed and pushed to the repo; treat it as a dead credential
  // going forward regardless of rotation status, and fail closed instead of
  // ever silently reusing a value that's sat in git history.
  const url =
    process.env.SUPABASE_URL ||
    "https://vmkytsytxlofjyeotmgb.supabase.co";
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!key) {
    console.error(
      "🌐 [WEB-SYNC] SUPABASE_SERVICE_KEY not set — remote refresh listener disabled " +
        "(the web dashboard's 'refresh now' button won't reach this desktop instance)"
    );
    return;
  }

  const maybeClient = supabaseClient({ realtime: { params: { eventsPerSecond: 2 } } });
  if (!maybeClient) return;   // offline, or no service key — see supabaseClient.ts
  /* Re-bound non-null. The helpers below are hoisted FUNCTION DECLARATIONS, and
     TypeScript will not carry a narrowing into one of those — it cannot prove
     when they are called. */
  const supabase = maybeClient;

  /** Resolve company from the live source of truth; fall back to the passed
   *  literal if the lookup fails (table empty / network). */
  async function resolveCompany(): Promise<string> {
    try {
      const { data, error } = await supabase
        .from("tally_companies")
        .select("name")
        .order("synced_at", { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle();
      if (!error && data?.name) return data.name as string;
    } catch {
      /* fall through to fallbackCompany */
    }
    return fallbackCompany;
  }

  /** Sweep rows this instance can now see are dead from a prior crashed
   *  session (stuck at pending/ack past STALE_MS) so they don't sit
   *  invisible forever — see docs/... gap analysis, "no reaper" finding. */
  async function sweepStaleCommands(company: string): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - STALE_MS).toISOString();
      const { data, error } = await supabase
        .from("tally_refresh_commands")
        .update({ status: "error" })
        .in("status", ["pending", "ack"])
        .eq("company", company)
        .lt("created_at", cutoff)
        .select("id");
      if (error) {
        console.warn(`🌐 [WEB-SYNC] Stale-command sweep failed: ${error.message}`);
      } else if (data && data.length > 0) {
        console.log(
          `🌐 [WEB-SYNC] Swept ${data.length} stale command(s) from a prior session ` +
            `(company="${company}")`
        );
      }
    } catch (err: any) {
      console.warn(`🌐 [WEB-SYNC] Stale-command sweep failed: ${err.message}`);
    }
  }

  let currentCompany: string | null = null;
  let currentHandle: SubscriptionHandle | null = null;

  async function resolveAndSubscribe(): Promise<void> {
    const company = await resolveCompany();
    if (company === currentCompany) return;

    if (currentCompany !== null && company !== currentCompany) {
      console.log(
        `🌐 [WEB-SYNC] Company changed "${currentCompany}" → "${company}" — resubscribing`
      );
    } else if (company !== fallbackCompany) {
      console.log(
        `🌐 [WEB-SYNC] Resolved company from tally_companies: "${company}" ` +
          `(fallback was "${fallbackCompany}")`
      );
    }

    // Mark the old handle retired BEFORE tearing it down, so its own
    // CHANNEL_ERROR/CLOSED handler (fired by removeChannel itself) does not
    // read as a drop worth reconnecting — it is expected, this is a deliberate
    // swap, not the dropped-connection case reconnectChannel exists for.
    if (currentHandle) {
      currentHandle.retired = true;
      supabase.removeChannel(currentHandle.channel);
    }
    currentCompany = company;
    await sweepStaleCommands(company);
    currentHandle = subscribeForCompany(supabase, localPort, company);
  }

  void resolveAndSubscribe();
  setInterval(() => void resolveAndSubscribe(), COMPANY_RECHECK_MS);
}

/**
 * A live subscription plus the flag that tells its own status callback
 * whether a CHANNEL_ERROR/TIMED_OUT/CLOSED is a real drop (reconnect) or an
 * expected teardown from `resolveAndSubscribe` swapping companies (don't).
 */
interface SubscriptionHandle {
  channel: ReturnType<SupabaseClient["channel"]>;
  retired: boolean;
}

// Reconnect backoff after a dropped channel: 2s, 4s, 8s, 16s, capped at 30s.
// This is the fix for the root cause found 24-Sep-2026 — the Realtime
// channel's own `.subscribe()` callback logged CHANNEL_ERROR/TIMED_OUT and
// did nothing else, so a single dropped websocket permanently stopped this
// listener from ever seeing another INSERT until the whole desktop process
// restarted. `resolveAndSubscribe` only re-subscribes when the COMPANY name
// changes (rare), so a dead channel under an unchanged company name sat dead
// indefinitely — live evidence: tally_refresh_commands rows inserted after
// 2026-09-23 18:16 sat at status="pending" forever, both price-list-scoped
// and full-refresh, while the desktop's own scheduled syncs kept running
// fine (they don't go through this channel) — the channel, not Tally, was
// the broken link.
export const RECONNECT_BASE_MS = 2_000;
export const RECONNECT_MAX_MS = 30_000;

/** Exponential backoff for the Nth reconnect attempt, capped. Pure, so the
 *  schedule is testable without a real channel or a real clock. */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.max(0, attempt));
}

/** Whether a channel status callback should trigger a reconnect. `retired`
 *  means this handle was deliberately torn down (company swap) — its own
 *  CLOSED/CHANNEL_ERROR is expected and must not spawn a competing handle. */
export function shouldReconnect(status: string, retired: boolean): boolean {
  return !retired && (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED");
}

function subscribeForCompany(
  supabase: SupabaseClient,
  localPort: number,
  company: string,
  attempt = 0
): SubscriptionHandle {
  // ── Burst coalescing ───────────────────────────────────────────────────────
  // Rapid commands (e.g. the user clicking "7-day" then "30-day" within seconds)
  // are merged into ONE sync at the WIDEST requested scope, which supersets every
  // narrower trailing window. Without this, only whichever command won the syncGuard
  // race was honoured and the rest were silently marked done — so a "30-day" click
  // could resolve to a 7-day pull, or vice-versa (bug report 2026-07-02).
  type Batch = { ids: number[]; widestDays: unknown; retries: number };
  const COALESCE_MS = 8_000;
  const MAX_BUSY_RETRIES = 22; // ~3 min at 8s — within the web dashboard's 3-min poll window
  let batch: Batch | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const setStatus = (ids: number[], status: string) =>
    supabase.from("tally_refresh_commands").update({ status }).in("id", ids);

  const armTimer = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void fireBatch(), COALESCE_MS);
  };

  // Merge a batch into the current buffer (or start one) and re-arm. In its own
  // function so TS evaluates `batch` fresh — inside fireBatch the earlier `batch = null`
  // over-narrows it (it can't see concurrent handlers reassigning across the await).
  const requeue = (b: Batch): void => {
    if (!batch) {
      batch = b;
    } else {
      batch.ids = Array.from(new Set([...b.ids, ...batch.ids]));
      if (rankDays(b.widestDays) > rankDays(batch.widestDays)) batch.widestDays = b.widestDays;
      batch.retries = Math.max(batch.retries, b.retries);
    }
    armTimer();
  };

  async function fireBatch(): Promise<void> {
    const b = batch;
    batch = null;
    timer = null;
    if (!b) return;
    const { ids } = b;
    const { from, to, label } = rangeForDays(b.widestDays);

    console.log("");
    console.log("🌐 ──────────────────────────────────────────────────────");
    console.log(`🌐 [WEB-SYNC] Firing sync for ${ids.length} coalesced command(s): [${ids.join(", ")}]`);
    console.log(`🌐 [WEB-SYNC]   • company     : ${company}`);
    console.log(`🌐 [WEB-SYNC]   • widest scope: ${from} → ${to}  (${label}, daily chunks)`);
    console.log("🌐 ──────────────────────────────────────────────────────");

    try {
      // Uses Node's http client (not fetch) so a full-FY refresh (~90 min) isn't
      // aborted by undici's 5-min headersTimeout. See localSyncClient.ts.
      const resp = await postTallySync(localPort, {
        company, fromDate: from, toDate: to, mode: "full", chunkStrategy: "daily",
      });

      if (resp.ok) {
        const result: any = resp.json;
        // The orchestrator returns { success:false } on zero rows (wrong company /
        // Tally closed). Don't report that as success.
        if (result && result.success === false) {
          console.error(
            `🌐 [WEB-SYNC] ✗ No data [${ids.join(", ")}]: ` +
              `${result.error || "Tally returned zero rows — check the company name and that Tally is open"}`
          );
          await setStatus(ids, "error");
        } else {
          const s = result?.stats;
          console.log(
            s
              ? `🌐 [WEB-SYNC] ✓ Completed [${ids.join(", ")}]: ${s.vouchers ?? 0} vouchers, ` +
                  `${s.stockItems ?? 0} items, ${s.ledgers ?? 0} ledgers in ${s.elapsedSeconds ?? "?"}s`
              : `🌐 [WEB-SYNC] ✓ Completed [${ids.join(", ")}]`
          );
          await setStatus(ids, "done");
        }
      } else if (resp.status === 409) {
        // Another sync (nightly / an earlier batch) holds Tally's single-threaded port.
        // Re-queue and retry within the web's poll window rather than dropping this
        // batch's scope. Merge with any batch that formed while we were blocked.
        if (b.retries < MAX_BUSY_RETRIES) {
          b.retries++;
          requeue(b);
          console.log(
            `🌐 [WEB-SYNC] ⏭ Busy — another sync running; retry ${b.retries}/${MAX_BUSY_RETRIES} ` +
              `in ${COALESCE_MS / 1000}s [${ids.join(", ")}]`
          );
        } else {
          console.log(
            `🌐 [WEB-SYNC] ⏭ Still busy after ${MAX_BUSY_RETRIES} retries — marking done; ` +
              `a concurrent sync is refreshing the data [${ids.join(", ")}]`
          );
          await setStatus(ids, "done");
        }
      } else {
        throw new Error(`HTTP ${resp.status}`);
      }
    } catch (err: any) {
      console.error(`🌐 [WEB-SYNC] ✗ Failed [${ids.join(", ")}]: ${err.message}`);
      await setStatus(ids, "error");
    }
  }

  /**
   * The price-list (+ GST) path — coalesced the same way `fireBatch` coalesces
   * full-refresh commands, and for a reason unique to this catch-up path:
   * a channel drop can leave SEVERAL price_list commands stuck pending at
   * once (the web's "Refresh now" retried, or several tabs), and catch-up on
   * reconnect replays all of them in one pass. Without coalescing that would
   * fire the same 0.18s pull N times in a row for one missed evening — cheap
   * individually, but pointless, and it made the pull log noisy in testing.
   * A single-item "batch" is the ordinary case and behaves exactly as before.
   *
   * Retries on 409 the same way `fireBatch` does, and for the same reason:
   * Tally's XML port is single-threaded, so "another sync is running" is a
   * wait, not a failure. Marking it `error` would put a red state on a button
   * whose request is perfectly good and about to be servable.
   *
   * `includeGst: true` — owner's words, 23-Sep-2026: "GST should also auto
   * pull with that". A manual "refresh price list" click now refreshes GST
   * too, via the same route the daily scheduler uses (priceGstDailySync.ts).
   */
  type PriceBatch = { ids: number[]; retries: number };
  let priceBatch: PriceBatch | null = null;
  let priceTimer: ReturnType<typeof setTimeout> | null = null;

  const armPriceTimer = () => {
    if (priceTimer) clearTimeout(priceTimer);
    priceTimer = setTimeout(() => void firePriceListBatch(), COALESCE_MS);
  };

  const requeuePriceBatch = (b: PriceBatch): void => {
    if (!priceBatch) {
      priceBatch = b;
    } else {
      priceBatch.ids = Array.from(new Set([...b.ids, ...priceBatch.ids]));
      priceBatch.retries = Math.max(priceBatch.retries, b.retries);
    }
    armPriceTimer();
  };

  /** Queue one price_list command. Several queued within COALESCE_MS collapse
   *  into the single fire below — see the comment on the batch above. */
  function queuePriceList(id: number): void {
    if (!priceBatch) {
      priceBatch = { ids: [id], retries: 0 };
    } else {
      priceBatch.ids.push(id);
    }
    armPriceTimer();
    console.log(
      `🌐 [WEB-SYNC] Queued price-list pull id=${id} — coalescing, firing in ${COALESCE_MS / 1000}s`
    );
  }

  async function firePriceListBatch(): Promise<void> {
    const b = priceBatch;
    priceBatch = null;
    priceTimer = null;
    if (!b) return;
    const { ids } = b;
    try {
      const resp = await postTallySync(
        localPort, { company, origin: "web-price-list", includeGst: true }, "/api/tally/sync-price-list",
      );
      if (resp.ok && resp.json?.success) {
        console.log(
          `🌐 [WEB-SYNC] ✓ Price list [${ids.join(", ")}]: ${resp.json.count} rows, ${resp.json.items} items` +
            (resp.json.gst ? `, ${resp.json.gst.rows} GST rates` : resp.json.gstError ? ` (GST failed: ${resp.json.gstError})` : "") +
            ` in ${resp.json.elapsedMs}ms`,
        );
        await setStatus(ids, "done");
        return;
      }
      if (resp.status === 409 && b.retries < MAX_BUSY_RETRIES) {
        b.retries++;
        requeuePriceBatch(b);
        console.log(
          `🌐 [WEB-SYNC] ⏭ Price list busy — retry ${b.retries}/${MAX_BUSY_RETRIES} in ${COALESCE_MS / 1000}s [${ids.join(", ")}]`
        );
        return;
      }
      /* A zero-row pull comes back 200 with success:false — the wrong company,
         or Tally closed. It is reported as an error rather than passing as a
         refresh, because the alternative is yesterday's rates wearing today's
         timestamp. */
      console.error(`🌐 [WEB-SYNC] ✗ Price list [${ids.join(", ")}]: ${resp.json?.error ?? `HTTP ${resp.status}`}`);
      await setStatus(ids, "error");
    } catch (err: any) {
      console.error(`🌐 [WEB-SYNC] ✗ Price list [${ids.join(", ")}]: ${err.message}`);
      await setStatus(ids, "error");
    }
  }

  /**
   * Atomically claim one command: flips it pending → ack ONLY if it is still
   * pending, and reports whether THIS call was the one that flipped it.
   *
   * This is what makes catch-up safe to run alongside realtime: a command can
   * arrive on both paths (the INSERT fires while catch-up's SELECT is still
   * in flight) and Postgres's row lock on the UPDATE means exactly one of the
   * two racing calls sees `pending` and wins. The loser sees zero rows
   * affected and treats it as already handled — never a second pull, never a
   * double-counted push to Tally's single-threaded port.
   */
  async function claimCommand(id: number): Promise<boolean> {
    const { data, error } = await supabase
      .from("tally_refresh_commands")
      .update({ status: "ack" })
      .eq("id", id)
      .eq("status", "pending")
      .select("id");
    if (error) {
      console.warn(`🌐 [WEB-SYNC] Claim failed for id=${id}: ${error.message}`);
      return false;
    }
    return !!data && data.length > 0;
  }

  /**
   * The one handler behind both the realtime INSERT callback and catch-up's
   * replay on reconnect — same claim, same routing, same coalescing either
   * way, so a command run twice by accident is a no-op, not a double pull.
   */
  async function handleIncomingCommand(row: { id: number; days: unknown; scope: string | null }): Promise<void> {
    const claimed = await claimCommand(row.id);
    if (!claimed) return; // already ack'd by the other path — idempotent no-op

    if (row.scope === "price_list") {
      /* A scoped command is NOT merged into the full-refresh burst buffer —
         see the comment above `queuePriceList`'s definition for why a
         price-list pull is a different question with no date window. */
      queuePriceList(row.id);
      return;
    }

    // Add to the burst buffer BEFORE any await — Node runs this synchronous
    // section to completion, so concurrent handlers can't race on `batch`.
    if (!batch) {
      batch = { ids: [row.id], widestDays: row.days, retries: 0 };
    } else {
      batch.ids.push(row.id);
      if (rankDays(row.days) > rankDays(batch.widestDays)) batch.widestDays = row.days;
    }
    armTimer();
    console.log(
      `🌐 [WEB-SYNC] Queued refresh id=${row.id} (${fmtDays(row.days)}) — ` +
        `coalescing burst, firing in ${COALESCE_MS / 1000}s`
    );
  }

  /**
   * Replays commands missed while the channel was down.
   *
   * Realtime does not redeliver INSERTs from before a subscription existed,
   * and `sweepStaleCommands` only turns OLD (>STALE_MS) pending rows into
   * "error" — it does not run them. Between those two, a command inserted
   * while the channel was silently dead and still younger than STALE_MS was
   * never processed at all: this is the gap behind the live evidence in
   * `reconnectDelayMs`'s header comment (rows 2611-2615, pending forever).
   *
   * Runs on every SUBSCRIBED — the first subscribe and every reconnect —
   * oldest first, through the SAME `handleIncomingCommand` the realtime path
   * uses, so `claimCommand` makes it safe to race against a real INSERT that
   * arrives in the same moment.
   */
  async function catchUpPending(): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - STALE_MS).toISOString();
      const { data, error } = await supabase
        .from("tally_refresh_commands")
        .select("id, days, scope, created_at")
        .eq("company", company)
        .eq("status", "pending")
        .gte("created_at", cutoff)
        .order("created_at", { ascending: true });
      if (error) {
        console.warn(`🌐 [WEB-SYNC] Catch-up query failed: ${error.message}`);
        return;
      }
      const rows = data ?? [];
      if (rows.length === 0) return;
      console.log(
        `🌐 [WEB-SYNC] Catch-up: ${rows.length} pending command(s) from before/during a channel drop — replaying`
      );
      for (const r of rows) {
        await handleIncomingCommand({
          id: Number((r as any).id),
          days: (r as any).days,
          scope: (r as any).scope ?? null,
        });
      }
    } catch (err: any) {
      console.warn(`🌐 [WEB-SYNC] Catch-up sweep failed: ${err.message}`);
    }
  }

  // One channel per company so multiple desktop instances don't cross-trigger.
  const channelName = `refresh-listener-${company
    .replace(/[^a-zA-Z0-9]/g, "_")
    .toLowerCase()}`;

  const handle: SubscriptionHandle = { channel: null as any, retired: false };

  handle.channel = supabase
    .channel(channelName)
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "tally_refresh_commands",
        // Only rows for THIS company — matches what the web inserts (its
        // useCompany() resolves to the same tally_companies.name we resolved above).
        filter: `company=eq.${company}`,
      },
      async (payload) => {
        await handleIncomingCommand({
          id: (payload.new as any).id,
          days: (payload.new as any).days,
          scope: (payload.new as any).scope ?? null,
        });
      }
    )
    .subscribe((status, err) => {
      if (status === "SUBSCRIBED") {
        console.log(
          `🌐 [WEB-SYNC] ✓ Listening for remote refresh (company="${company}")`
        );
        attempt = 0; // a live connection clears the backoff streak
        // Fires on the FIRST subscribe too, not just a reconnect — a command
        // inserted in the gap between server startup and SUBSCRIBED is the
        // same kind of miss as one inserted during a drop.
        void catchUpPending();
      } else if (shouldReconnect(status, handle.retired)) {
        const delay = reconnectDelayMs(attempt);
        console.error(
          `🌐 [WEB-SYNC] ✗ Channel ${status}${err ? " — " + err.message : ""} ` +
            `(company="${company}") — reconnecting in ${delay / 1000}s so refresh commands ` +
            `keep being picked up`
        );
        handle.retired = true; // this handle is done; supersede it below
        supabase.removeChannel(handle.channel);
        setTimeout(() => {
          const next = subscribeForCompany(supabase, localPort, company, attempt + 1);
          handle.channel = next.channel;
          handle.retired = next.retired;
        }, delay);
      }
    });

  return handle;
}
