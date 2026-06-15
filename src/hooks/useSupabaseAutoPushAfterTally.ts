import { useEffect, useRef } from "react";
import { useTallyStore } from "../store/tallyStore";
import { useDataStore } from "../store/dataStore";
import { syncConfigToSupabase } from "./useSupabaseConfigSync";
import { useSupabaseSyncStatusStore } from "../store/supabaseSyncStatusStore";

/**
 * Hook that automatically pushes EVERYTHING to Supabase 5 minutes after each
 * Tally sync completes.
 *
 * Triggered by any change to `tallyStore.lastSyncAt`. If a second Tally sync
 * happens within the 5-minute window, the timer resets (debounce-style) so
 * the push fires once, 5 min after the most recent sync.
 *
 * Pushes are wide:
 *   • Config: discount rules, order groups, item assignments, category colors,
 *     vendor group assignments, unit/rate overrides, item notes, calling list,
 *     Tally price list imports (via /api/supabase/sync-config)
 *   • Local data: items, ledgers, vouchers with full inventory + ledger lines
 *     (via /api/supabase/sync)
 *
 * Best-effort: failures are warned to console only — won't bother the user
 * with toasts since this fires in the background.
 */
const DELAY_MS = 5 * 60 * 1000; // 5 minutes
const RETRY_DELAY_MS = 60 * 1000; // 60s retry after a failed push
const SERVER_URL = "http://localhost:3100/api/supabase/sync";

/**
 * Runs the actual masters+vouchers push. Records per-channel status and returns
 * {mastersVouchersOk, configOk} so the caller can decide whether to schedule a retry.
 * Splits the response into "masters" + "vouchers" channels because the server
 * endpoint covers both — if either side fails we want NavBar to reflect it.
 */
async function pushAll(label: string): Promise<{ mastersVouchersOk: boolean; configOk: boolean }> {
  const status = useSupabaseSyncStatusStore.getState();
  const data = useDataStore.getState().data;
  if (!data) {
    console.warn(`[${label}] No local data to push (still loading?)`);
    return { mastersVouchersOk: true, configOk: true }; // not a failure — nothing to push
  }
  const company = data.company?.name || "M.K.CYCLES (P) LTD.";

  const items = Array.from(data.items.values());
  const ledgers = Array.from(data.ledgers.values());
  const vouchers = data.vouchers;

  console.log(`[${label}] Firing — config + ${items.length} items + ${ledgers.length} ledgers + ${vouchers.length} vouchers`);

  const [configResult, voucherResp] = await Promise.allSettled([
    syncConfigToSupabase(company),
    fetch(SERVER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ company, items, ledgers, vouchers }),
    }).then(async (r) => {
      const j = await r.json();
      if (!r.ok || !j.success) throw new Error(j.error || `HTTP ${r.status}`);
      return j;
    }),
  ]);

  // configResult.value already recorded its own status via syncConfigToSupabase.
  const configOk =
    configResult.status === "fulfilled" &&
    configResult.value.success &&
    (!configResult.value.errors || configResult.value.errors.length === 0);

  if (configResult.status === "fulfilled" && configResult.value.success) {
    console.log(`[${label}] ✓ Config synced:`, configResult.value.counts);
    if (configResult.value.errors?.length) {
      console.warn(`[${label}] Config had per-table errors:`, configResult.value.errors);
    }
  } else {
    console.warn(`[${label}] Config sync failed:`, configResult.status === "fulfilled" ? configResult.value.errors : configResult.reason);
  }

  // Treat masters + vouchers as one channel for the indicator (they ship in one request).
  // Record both channels so the NavBar's per-channel display is accurate.
  let mastersVouchersOk: boolean;
  if (voucherResp.status === "fulfilled") {
    console.log(`[${label}] ✓ Masters + vouchers synced:`, voucherResp.value);
    status.recordResult("masters", true);
    status.recordResult("vouchers", true);
    mastersVouchersOk = true;
  } else {
    const errMsg = (voucherResp.reason as any)?.message || String(voucherResp.reason);
    console.warn(`[${label}] Masters + vouchers sync rejected: ${errMsg}`);
    status.recordResult("masters", false, errMsg);
    status.recordResult("vouchers", false, errMsg);
    mastersVouchersOk = false;
  }

  return { mastersVouchersOk, configOk };
}

export function useSupabaseAutoPushAfterTally() {
  const lastSyncAt = useTallyStore((s) => s.lastSyncAt);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!lastSyncAt) return;

    if (timerRef.current) clearTimeout(timerRef.current);
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);

    console.log(`[Auto-push] Scheduled push to Supabase 5 min after sync at ${lastSyncAt}`);

    timerRef.current = setTimeout(async () => {
      try {
        const { mastersVouchersOk, configOk } = await pushAll("Auto-push");
        // If anything failed, fire ONE retry in 60s. Don't loop — the 15-min
        // interval hook will catch anything still broken after that.
        if (!mastersVouchersOk || !configOk) {
          const status = useSupabaseSyncStatusStore.getState();
          status.setRetryScheduled("masters", true);
          status.setRetryScheduled("vouchers", true);
          status.setRetryScheduled("config", true);
          console.log(`[Auto-push] Push failed — scheduling 60s retry`);
          retryTimerRef.current = setTimeout(async () => {
            console.log(`[Auto-push] Retrying after failure…`);
            await pushAll("Auto-push retry");
            const s = useSupabaseSyncStatusStore.getState();
            s.setRetryScheduled("masters", false);
            s.setRetryScheduled("vouchers", false);
            s.setRetryScheduled("config", false);
          }, RETRY_DELAY_MS);
        }
      } catch (e: any) {
        console.warn(`[Auto-push] Unexpected error: ${e?.message || e}`);
      }
    }, DELAY_MS);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
  }, [lastSyncAt]);
}
