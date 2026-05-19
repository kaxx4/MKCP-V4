import { useEffect, useRef } from "react";
import { useTallyStore } from "../store/tallyStore";
import { useDataStore } from "../store/dataStore";
import { syncConfigToSupabase } from "./useSupabaseConfigSync";

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
const SERVER_URL = "http://localhost:3100/api/supabase/sync";

export function useSupabaseAutoPushAfterTally() {
  const lastSyncAt = useTallyStore((s) => s.lastSyncAt);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!lastSyncAt) return;

    // Clear any pending timer — debounce so rapid syncs collapse to one push
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }

    console.log(`[Auto-push] Scheduled push to Supabase 5 min after sync at ${lastSyncAt}`);

    timerRef.current = setTimeout(async () => {
      try {
        const data = useDataStore.getState().data;
        if (!data) {
          console.warn("[Auto-push] No local data to push (still loading?)");
          return;
        }
        const company = data.company?.name || "M.K.CYCLES (P) LTD.";

        console.log(`[Auto-push] Firing — config + ${data.items.size} items + ${data.ledgers.size} ledgers + ${data.vouchers.length} vouchers`);

        const items = Array.from(data.items.values());
        const ledgers = Array.from(data.ledgers.values());
        const vouchers = data.vouchers;

        // Run config + voucher sync in parallel
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

        if (configResult.status === "fulfilled" && configResult.value.success) {
          console.log("[Auto-push] ✓ Config synced:", configResult.value.counts);
        } else if (configResult.status === "fulfilled") {
          console.warn("[Auto-push] Config sync had errors:", configResult.value.errors);
        } else {
          console.warn("[Auto-push] Config sync rejected:", configResult.reason);
        }

        if (voucherResp.status === "fulfilled") {
          console.log("[Auto-push] ✓ Vouchers + masters synced:", voucherResp.value);
        } else {
          console.warn("[Auto-push] Voucher sync rejected:", voucherResp.reason);
        }
      } catch (e: any) {
        console.warn(`[Auto-push] Failed: ${e?.message || e}`);
      }
    }, DELAY_MS);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [lastSyncAt]);
}
