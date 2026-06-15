import { useEffect, useRef } from "react";
import { useDataStore } from "../store/dataStore";
import { syncConfigToSupabase } from "./useSupabaseConfigSync";
import { useSupabaseSyncStatusStore } from "../store/supabaseSyncStatusStore";

/**
 * Hook that automatically pushes EVERYTHING to Supabase every 15 minutes,
 * regardless of whether Tally sync has run.
 *
 * This is in addition to:
 *  - useSupabaseConfigSync (2-second debounce on every config edit)
 *  - useSupabaseAutoPushAfterTally (5 minutes after every Tally sync)
 *
 * The 15-min cadence guarantees user-edited data lands in Supabase even
 * if they never trigger a Tally sync — useful for sessions where someone
 * spends an hour editing discount rules, order groups, calendar overrides,
 * etc., then closes the app without ever clicking Push.
 *
 * Pushes:
 *   • Config: discount rules, order groups, item assignments, category colors,
 *     vendor group assignments, unit/rate overrides, item notes, calling list,
 *     Tally price list imports, calendar/voucher overrides
 *   • Local data: items, ledgers, vouchers with full inventory + ledger lines
 *
 * Best-effort: failures are warned to console only, no UI noise.
 */
const INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const RETRY_DELAY_MS = 60 * 1000;   // 60s retry after a failure
const SERVER_URL = "http://localhost:3100/api/supabase/sync";

async function pushAll(label: string): Promise<{ mastersVouchersOk: boolean; configOk: boolean }> {
  const status = useSupabaseSyncStatusStore.getState();
  const data = useDataStore.getState().data;
  if (!data) return { mastersVouchersOk: true, configOk: true };
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

  let mastersVouchersOk: boolean;
  if (voucherResp.status === "fulfilled") {
    console.log(`[${label}] ✓ Masters + vouchers synced:`, voucherResp.value);
    status.recordResult("masters", true);
    status.recordResult("vouchers", true);
    mastersVouchersOk = true;
  } else {
    const errMsg = (voucherResp.reason as any)?.message || String(voucherResp.reason);
    console.warn(`[${label}] Masters + vouchers rejected: ${errMsg}`);
    status.recordResult("masters", false, errMsg);
    status.recordResult("vouchers", false, errMsg);
    mastersVouchersOk = false;
  }

  return { mastersVouchersOk, configOk };
}

export function useSupabaseAutoPushInterval() {
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const fire = async () => {
      try {
        const { mastersVouchersOk, configOk } = await pushAll("Auto-push-15min");
        if (!mastersVouchersOk || !configOk) {
          if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
          const status = useSupabaseSyncStatusStore.getState();
          status.setRetryScheduled("masters", true);
          status.setRetryScheduled("vouchers", true);
          status.setRetryScheduled("config", true);
          console.log(`[Auto-push-15min] Push failed — scheduling 60s retry`);
          retryTimerRef.current = setTimeout(async () => {
            console.log(`[Auto-push-15min] Retrying after failure…`);
            await pushAll("Auto-push-15min retry");
            const s = useSupabaseSyncStatusStore.getState();
            s.setRetryScheduled("masters", false);
            s.setRetryScheduled("vouchers", false);
            s.setRetryScheduled("config", false);
          }, RETRY_DELAY_MS);
        }
      } catch (e: any) {
        console.warn(`[Auto-push-15min] Unexpected error: ${e?.message || e}`);
      }
    };

    const id = setInterval(fire, INTERVAL_MS);
    console.log(`[Auto-push-15min] Scheduled: pushes EVERYTHING to Supabase every 15 min`);
    return () => {
      clearInterval(id);
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
  }, []);
}
