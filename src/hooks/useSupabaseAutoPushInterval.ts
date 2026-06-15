import { useEffect, useRef } from "react";
import { useSupabaseSyncStatusStore } from "../store/supabaseSyncStatusStore";
import { pushAll } from "../services/supabasePushAll";

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
const INTERVAL_MS = 15 * 60 * 1000;
const RETRY_DELAY_MS = 60 * 1000;

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
