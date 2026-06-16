import { useEffect, useRef } from "react";
import { useTallyStore } from "../store/tallyStore";
import { useDataStore } from "../store/dataStore";
import { syncDayBook } from "../api/tallyApi";
import { parseTransactions } from "../parser/transactionParser";
import { loadData, createBackup } from "../db/idb";
import { deserializeParsedData } from "../utils/serialize";
import { useToast } from "../components/Toast";

function ymd(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}
function todayStr(): string {
  return ymd(new Date());
}
/** YYYYMMDD for `daysBack` days before today (0 = today). */
function daysAgoStr(daysBack: number): string {
  const d = new Date();
  d.setDate(d.getDate() - Math.max(0, daysBack));
  return ymd(d);
}
/** "20260610" → "2026-06-10" (voucher dates are stored ISO-dashed). */
function toIso(yyyymmdd: string): string {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
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
  const windowDays        = useTallyStore((s) => s.tallySyncWindowDays);
  const strategy          = useTallyStore((s) => s.tallySyncStrategy);
  const deepMinutes       = useTallyStore((s) => s.tallyDeepSyncMinutes);
  const deepWindowDays    = useTallyStore((s) => s.tallyDeepSyncWindowDays);
  const setSyncing        = useTallyStore((s) => s.setSyncing);
  const completeSyncWith  = useTallyStore((s) => s.completeSyncWith);
  const mergeData = useDataStore((s) => s.mergeData);
  const replaceVouchersInRange = useDataStore((s) => s.replaceVouchersInRange);
  const { toast } = useToast();

  const windowRef = useRef(windowDays);
  useEffect(() => { windowRef.current = windowDays; }, [windowDays]);
  const strategyRef = useRef(strategy);
  useEffect(() => { strategyRef.current = strategy; }, [strategy]);
  const deepWindowRef = useRef(deepWindowDays);
  useEffect(() => { deepWindowRef.current = deepWindowDays; }, [deepWindowDays]);

  const isSyncingRef = useRef(isSyncing);
  useEffect(() => { isSyncingRef.current = isSyncing; }, [isSyncing]);

  const isConnectedRef = useRef(isConnected);
  useEffect(() => { isConnectedRef.current = isConnected; }, [isConnected]);

  const companyRef = useRef(companyName);
  useEffect(() => { companyRef.current = companyName; }, [companyName]);

  useEffect(() => {
    const runSync = async (winDaysRaw: number, label: string) => {
      if (!isConnectedRef.current || isSyncingRef.current || !companyRef.current.trim()) return;

      const today = todayStr();
      // Bounded date window, daily chunks by default — keeps each Tally request
      // tiny so the in-process server never gets overloaded by a big pull.
      const win = Number.isFinite(winDaysRaw) ? Math.max(1, winDaysRaw) : 7;
      const from = daysAgoStr(win - 1);
      const strat = strategyRef.current || "daily";
      console.log(`[auto-sync:${label}] Daybook sync ${from}→${today} (${win}d, ${strat})`);
      setSyncing(true);

      try {
        const result = await syncDayBook(companyRef.current, from, today, strat);

        if (!result.data?.tallymessage?.length) {
          console.log("[auto-sync] No vouchers in window yet.");
          return;
        }

        const parsed = parseTransactions(result.data);

        const existingRaw = await loadData<unknown>("parsedData");
        const existing = existingRaw ? deserializeParsedData(existingRaw) : null;
        if (existing) await createBackup(existingRaw, "pre-auto-sync");

        // Only treat the pull as authoritative for the window (i.e. safe to delete
        // vouchers no longer in Tally) when EVERY chunk succeeded. A partial pull
        // would otherwise wrongly clear vouchers that simply weren't fetched.
        const cleanPull = (result.stats?.chunksFailed ?? 1) === 0;

        if (cleanPull && existing) {
          // Replace the whole window: drops any voucher deleted/converted in Tally.
          replaceVouchersInRange(parsed.vouchers, toIso(from), toIso(today));
        } else {
          // Partial pull (or first load) — additive merge, never deletes.
          if (!parsed.vouchers.length) return;
          mergeData({
            company: existing?.company ?? { name: companyRef.current, fyStartMonth: 4 },
            items: existing?.items ?? new Map(),
            ledgers: existing?.ledgers ?? new Map(),
            vouchers: parsed.vouchers,
            importedAt: new Date().toISOString(),
            sourceFiles: ["tally-auto-sync"],
            warnings: parsed.warnings,
          });
        }

        const dates = parsed.vouchers.map((v) => v.date).filter(Boolean).sort();
        const lastDate = dates.length ? dates[dates.length - 1]! : null;
        completeSyncWith(new Date().toISOString(), lastDate);

        toast(`Auto-synced ${parsed.vouchers.length} voucher(s) (last ${win}d).`, "success");
        console.log(`[auto-sync] Done — ${parsed.vouchers.length} vouchers, window ${from}→${today}, clean=${cleanPull}.`);
      } catch (err: any) {
        console.warn("[auto-sync] Failed:", err.message);
        // Silent failure — don't toast errors on background sync
      } finally {
        setSyncing(false);
      }
    };

    const quickWin = () => (Number.isFinite(windowRef.current) ? Math.max(1, windowRef.current) : 7);
    const deepWin  = () => (Number.isFinite(deepWindowRef.current) ? Math.max(1, deepWindowRef.current) : 90);

    // Quick pass once on mount (after a short settle delay) — recent activity.
    const initialTimer = setTimeout(() => void runSync(quickWin(), "quick"), 10_000);

    // Quick pass on the configured interval. 0 = disabled.
    const minutes = Number.isFinite(intervalMinutes) ? intervalMinutes : 30;
    const interval = minutes > 0 ? setInterval(() => void runSync(quickWin(), "quick"), minutes * 60_000) : null;

    // Deep pass on its own (longer) interval — wider window that catches edits/
    // conversions to OLDER vouchers. 0 = disabled.
    const dMin = Number.isFinite(deepMinutes) ? deepMinutes : 360;
    const deepInterval = dMin > 0 ? setInterval(() => void runSync(deepWin(), "deep"), dMin * 60_000) : null;
    console.log(`[auto-sync] quick: ${minutes > 0 ? `${minutes} min / ${quickWin()}d` : "off"} · deep: ${dMin > 0 ? `${dMin} min / ${deepWin()}d` : "off"}`);

    return () => {
      clearTimeout(initialTimer);
      if (interval) clearInterval(interval);
      if (deepInterval) clearInterval(deepInterval);
    };
  }, [intervalMinutes, deepMinutes]); // re-arm when either interval changes
}
