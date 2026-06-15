import { useEffect, useRef } from "react";
import { useTallyStore } from "../store/tallyStore";
import { refreshDeliveryNotes, DN_REFRESH_WINDOW_DAYS } from "../services/deliveryNoteRefresh";
import { useToast } from "../components/Toast";

const INTERVAL_MS = 60 * 60 * 1000; // hourly

/**
 * Hourly background refresh of delivery notes (rolling {@link DN_REFRESH_WINDOW_DAYS}-day
 * window). Complements the 30-minute today-only voucher auto-sync: that one only catches
 * vouchers dated *today*, so older pending delivery notes that get fulfilled or cancelled
 * in Tally would never disappear from Pending Orders. This re-pulls the window and replaces
 * the stored DN set so it always mirrors Tally.
 *
 * Runs only when Tally is connected and no other sync is in flight. Silent on failure
 * (background task) — the manual "Sync Today" button surfaces errors instead.
 */
export function useDeliveryNoteAutoSync() {
  const { isConnected, isSyncing, companyName, setSyncing, setLastSync, setLastVouchersSync } =
    useTallyStore();
  const { toast } = useToast();

  const isSyncingRef = useRef(isSyncing);
  useEffect(() => { isSyncingRef.current = isSyncing; }, [isSyncing]);

  const isConnectedRef = useRef(isConnected);
  useEffect(() => { isConnectedRef.current = isConnected; }, [isConnected]);

  const companyRef = useRef(companyName);
  useEffect(() => { companyRef.current = companyName; }, [companyName]);

  useEffect(() => {
    const run = async () => {
      if (!isConnectedRef.current || isSyncingRef.current || !companyRef.current.trim()) return;

      console.log(`[dn-auto-sync] Refreshing delivery notes (last ${DN_REFRESH_WINDOW_DAYS} days)`);
      setSyncing(true);
      try {
        const { dnCount } = await refreshDeliveryNotes(companyRef.current);
        const now = new Date().toISOString();
        // Bump sync timestamps so the Supabase auto-push (fires 5 min after lastSyncAt
        // changes) propagates the refreshed delivery notes to the cloud.
        setLastSync(now);
        setLastVouchersSync(now);
        if (dnCount > 0) {
          toast(`Refreshed ${dnCount} delivery note(s) from Tally.`, "success");
        }
        console.log(`[dn-auto-sync] Done — ${dnCount} delivery notes in window.`);
      } catch (err: any) {
        console.warn("[dn-auto-sync] Failed:", err?.message ?? err);
        // Silent — background task.
      } finally {
        setSyncing(false);
      }
    };

    // First run shortly after mount (offset from the today-sync's 10s so they don't collide),
    // then hourly.
    const initial = setTimeout(run, 45_000);
    const interval = setInterval(run, INTERVAL_MS);
    return () => {
      clearTimeout(initial);
      clearInterval(interval);
    };
  }, []); // stable — reads via refs
}
