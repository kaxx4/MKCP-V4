import { useEffect, useRef } from "react";
import { useTallyStore } from "../store/tallyStore";
import { useSupabaseSyncStatusStore } from "../store/supabaseSyncStatusStore";
import { pushAll } from "../services/supabasePushAll";

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
const DELAY_MS = 5 * 60 * 1000;
const RETRY_DELAY_MS = 60 * 1000;

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
