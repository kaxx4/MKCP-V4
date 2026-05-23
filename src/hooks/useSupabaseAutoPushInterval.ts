import { useEffect } from "react";
import { useDataStore } from "../store/dataStore";
import { syncConfigToSupabase } from "./useSupabaseConfigSync";

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
const SERVER_URL = "http://localhost:3100/api/supabase/sync";

export function useSupabaseAutoPushInterval() {
  useEffect(() => {
    const fire = async () => {
      try {
        const data = useDataStore.getState().data;
        if (!data) {
          // No data loaded yet — skip silently. Will retry next interval.
          return;
        }
        const company = data.company?.name || "M.K.CYCLES (P) LTD.";

        const items = Array.from(data.items.values());
        const ledgers = Array.from(data.ledgers.values());
        const vouchers = data.vouchers;

        console.log(
          `[Auto-push-15min] Firing — config + ${items.length} items + ${ledgers.length} ledgers + ${vouchers.length} vouchers`
        );

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
          console.log("[Auto-push-15min] ✓ Config synced:", configResult.value.counts);
        } else if (configResult.status === "fulfilled") {
          console.warn("[Auto-push-15min] Config sync errors:", configResult.value.errors);
        } else {
          console.warn("[Auto-push-15min] Config sync rejected:", configResult.reason);
        }

        if (voucherResp.status === "fulfilled") {
          console.log("[Auto-push-15min] ✓ Masters + vouchers synced:", voucherResp.value);
        } else {
          console.warn("[Auto-push-15min] Voucher sync rejected:", voucherResp.reason);
        }
      } catch (e: any) {
        console.warn(`[Auto-push-15min] Failed: ${e?.message || e}`);
      }
    };

    // Fire interval — first push happens 15 min after mount.
    // We don't fire immediately on mount because useSupabaseConfigSync's 2s
    // debounce already covers fresh edits.
    const id = setInterval(fire, INTERVAL_MS);
    console.log(`[Auto-push-15min] Scheduled: pushes EVERYTHING to Supabase every 15 min`);
    return () => clearInterval(id);
  }, []);
}
