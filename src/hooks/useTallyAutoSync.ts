import { useEffect, useRef } from "react";
import { useTallyStore } from "../store/tallyStore";
import { useDataStore } from "../store/dataStore";
import { syncDayBook } from "../api/tallyApi";
import { parseTransactions } from "../parser/transactionParser";
import { loadData, createBackup } from "../db/idb";
import { deserializeParsedData } from "../utils/serialize";
import { useToast } from "../components/Toast";

function todayStr(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

/**
 * Silently syncs today's vouchers from Tally every 30 minutes.
 * Only runs when Tally is connected. No full-sync — daybook only.
 */
export function useTallyAutoSync() {
  const isConnected       = useTallyStore((s) => s.isConnected);
  const isSyncing         = useTallyStore((s) => s.isSyncing);
  const companyName       = useTallyStore((s) => s.companyName);
  const intervalMinutes   = useTallyStore((s) => s.tallyAutoSyncMinutes);
  const setSyncing        = useTallyStore((s) => s.setSyncing);
  const completeSyncWith  = useTallyStore((s) => s.completeSyncWith);
  const mergeData = useDataStore((s) => s.mergeData);
  const { toast } = useToast();

  const isSyncingRef = useRef(isSyncing);
  useEffect(() => { isSyncingRef.current = isSyncing; }, [isSyncing]);

  const isConnectedRef = useRef(isConnected);
  useEffect(() => { isConnectedRef.current = isConnected; }, [isConnected]);

  const companyRef = useRef(companyName);
  useEffect(() => { companyRef.current = companyName; }, [companyName]);

  useEffect(() => {
    const runSync = async () => {
      if (!isConnectedRef.current || isSyncingRef.current || !companyRef.current.trim()) return;

      const today = todayStr();
      console.log(`[auto-sync] Today's daybook sync — ${today}`);
      setSyncing(true);

      try {
        const result = await syncDayBook(companyRef.current, today, today, "daily");

        if (!result.data?.tallymessage?.length) {
          console.log("[auto-sync] No vouchers for today yet.");
          return;
        }

        const parsed = parseTransactions(result.data);
        if (!parsed.vouchers.length) return;

        const existingRaw = await loadData<unknown>("parsedData");
        const existing = existingRaw ? deserializeParsedData(existingRaw) : null;
        if (existing) await createBackup(existingRaw, "pre-auto-sync");

        mergeData({
          company: existing?.company ?? { name: companyRef.current, fyStartMonth: 4 },
          items: existing?.items ?? new Map(),
          ledgers: existing?.ledgers ?? new Map(),
          vouchers: parsed.vouchers,
          importedAt: new Date().toISOString(),
          sourceFiles: ["tally-auto-sync"],
          warnings: parsed.warnings,
        });

        const dates = parsed.vouchers.map((v) => v.date).filter(Boolean).sort();
        const lastDate = dates.length ? dates[dates.length - 1]! : null;
        completeSyncWith(new Date().toISOString(), lastDate);

        toast(`Auto-synced ${parsed.vouchers.length} voucher(s) from today.`, "success");
        console.log(`[auto-sync] Done — ${parsed.vouchers.length} vouchers merged.`);
      } catch (err: any) {
        console.warn("[auto-sync] Failed:", err.message);
        // Silent failure — don't toast errors on background sync
      } finally {
        setSyncing(false);
      }
    };

    // Run once immediately on mount (after a short delay to let the app settle)
    const initialTimer = setTimeout(runSync, 10_000);

    // Then every `intervalMinutes` minutes. 0 (or invalid) disables the repeat
    // entirely — only the one-shot initial run above fires. Falls back to the
    // 30-min default if the stored value is missing.
    const minutes = Number.isFinite(intervalMinutes) ? intervalMinutes : 30;
    const interval = minutes > 0 ? setInterval(runSync, minutes * 60_000) : null;
    console.log(`[auto-sync] Tally pull interval: ${minutes > 0 ? `${minutes} min` : "disabled"}`);

    return () => {
      clearTimeout(initialTimer);
      if (interval) clearInterval(interval);
    };
  }, [intervalMinutes]); // re-arm the timer when the configured interval changes
}
