import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import ws from "ws";
import { postTallySync } from "./localSyncClient.js";

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
 * guaranteed to match what the web inserts into tally_refresh_commands.company,
 * and it survives FY-rollover renames (e.g. the "- (from 1-Apr-26)" suffix
 * changing next year) without a code change. `fallbackCompany` (the TALLY_COMPANY
 * env / literal) is used only if that lookup returns nothing.
 *
 * Call once from index.ts inside the app.listen callback.
 */
export function startRefreshListener(localPort: number, fallbackCompany: string): void {
  if (started) return;
  started = true;

  // Reuse the same credentials SupabaseSync uses — hardcoded fallbacks are
  // fine here because they're already in the codebase.
  const url =
    process.env.SUPABASE_URL ||
    "https://vmkytsytxlofjyeotmgb.supabase.co";
  const key =
    process.env.SUPABASE_SERVICE_KEY ||
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZta3l0c3l0eGxvZmp5ZW90bWdiIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3ODY0MjAyMCwiZXhwIjoyMDk0MjE4MDIwfQ.W-LfPU_GMCFafIWjHt0n5bs1oC08IX7IuXLj6TVY1BU";

  const supabase = createClient(url, key, {
    realtime: { params: { eventsPerSecond: 2 } },
  });

  // Resolve the company from the live source of truth, then subscribe. If the
  // lookup fails (table empty / network), fall back to the passed literal so the
  // listener still comes up.
  void (async () => {
    let company = fallbackCompany;
    try {
      const { data, error } = await supabase
        .from("tally_companies")
        .select("name")
        .order("synced_at", { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle();
      if (!error && data?.name) {
        company = data.name;
        if (company !== fallbackCompany) {
          console.log(
            `🌐 [WEB-SYNC] Resolved company from tally_companies: "${company}" ` +
              `(fallback was "${fallbackCompany}")`
          );
        }
      }
    } catch {
      /* keep fallbackCompany */
    }
    subscribeForCompany(supabase, localPort, company);
  })();
}

function subscribeForCompany(
  supabase: SupabaseClient,
  localPort: number,
  company: string
): void {
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

  // One channel per company so multiple desktop instances don't cross-trigger.
  const channelName = `refresh-listener-${company
    .replace(/[^a-zA-Z0-9]/g, "_")
    .toLowerCase()}`;

  supabase
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
        const id: number = (payload.new as any).id;
        const days = (payload.new as any).days;
        // Add to the burst buffer BEFORE any await — Node runs this synchronous
        // section to completion, so concurrent handlers can't race on `batch`.
        if (!batch) {
          batch = { ids: [id], widestDays: days, retries: 0 };
        } else {
          batch.ids.push(id);
          if (rankDays(days) > rankDays(batch.widestDays)) batch.widestDays = days;
        }
        armTimer();
        console.log(
          `🌐 [WEB-SYNC] Queued refresh id=${id} (${fmtDays(days)}) — ` +
            `coalescing burst, firing in ${COALESCE_MS / 1000}s`
        );
        // Ack promptly so the web button leaves the "waiting" state.
        await setStatus([id], "ack");
      }
    )
    .subscribe((status, err) => {
      if (status === "SUBSCRIBED") {
        console.log(
          `🌐 [WEB-SYNC] ✓ Listening for remote refresh (company="${company}")`
        );
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        console.error(
          `🌐 [WEB-SYNC] ✗ Channel error: ${status}${err ? " — " + err.message : ""}`
        );
      }
    });
}
