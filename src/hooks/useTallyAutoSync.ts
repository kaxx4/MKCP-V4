import { useEffect, useRef } from "react";
import { useTallyStore } from "../store/tallyStore";
import { useToast } from "../components/Toast";
import { pullFromTally, todayYmd, daysAgoYmd } from "../services/tallyPull";

/**
 * Background Tally → app sync. Two passes:
 *   • quick — recent window (default 7d) every `tallyAutoSyncMinutes`
 *   • deep  — wider window (default 30d) every `tallyDeepSyncMinutes`, catches
 *             edits/conversions to older vouchers.
 * Both delegate to pullFromTally (shared with the manual quick-sync buttons),
 * which owns the global isSyncing lock so the Supabase push never collides.
 */
export function useTallyAutoSync() {
  const isConnected     = useTallyStore((s) => s.isConnected);
  const companyName     = useTallyStore((s) => s.companyName);
  const intervalMinutes = useTallyStore((s) => s.tallyAutoSyncMinutes);
  const windowDays      = useTallyStore((s) => s.tallySyncWindowDays);
  const strategy        = useTallyStore((s) => s.tallySyncStrategy);
  const deepMinutes     = useTallyStore((s) => s.tallyDeepSyncMinutes);
  const deepWindowDays  = useTallyStore((s) => s.tallyDeepSyncWindowDays);
  const { toast } = useToast();

  const windowRef = useRef(windowDays);
  useEffect(() => { windowRef.current = windowDays; }, [windowDays]);
  const strategyRef = useRef(strategy);
  useEffect(() => { strategyRef.current = strategy; }, [strategy]);
  const deepWindowRef = useRef(deepWindowDays);
  useEffect(() => { deepWindowRef.current = deepWindowDays; }, [deepWindowDays]);
  const isConnectedRef = useRef(isConnected);
  useEffect(() => { isConnectedRef.current = isConnected; }, [isConnected]);
  const companyRef = useRef(companyName);
  useEffect(() => { companyRef.current = companyName; }, [companyName]);

  useEffect(() => {
    const runSync = async (winDaysRaw: number, label: string) => {
      if (!isConnectedRef.current || !companyRef.current.trim()) return;
      const win = Number.isFinite(winDaysRaw) ? Math.max(1, winDaysRaw) : 7;
      const from = daysAgoYmd(win - 1);
      const strat = strategyRef.current || "daily";
      const res = await pullFromTally(companyRef.current, from, todayYmd(), strat);
      if (res.ok && (res.vouchers > 0 || res.cleared > 0)) {
        toast(`Auto-sync (${label}, ${win}d): ${res.vouchers} voucher(s)${res.cleared ? `, ${res.cleared} cleared` : ""}`, "success");
      } else if (!res.ok && res.error && res.error !== "A Tally sync is already running") {
        console.warn(`[auto-sync:${label}] ${res.error}`);
      }
    };

    const quickWin = () => (Number.isFinite(windowRef.current) ? Math.max(1, windowRef.current) : 7);
    const deepWin  = () => (Number.isFinite(deepWindowRef.current) ? Math.max(1, deepWindowRef.current) : 30);

    // Quick pass once on mount (after a short settle delay) — recent activity.
    const initialTimer = setTimeout(() => void runSync(quickWin(), "quick"), 10_000);

    // Quick pass on the configured interval. 0 = disabled.
    const minutes = Number.isFinite(intervalMinutes) ? intervalMinutes : 30;
    const interval = minutes > 0 ? setInterval(() => void runSync(quickWin(), "quick"), minutes * 60_000) : null;

    // Deep pass on its own (longer) interval — catches edits to OLDER vouchers.
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
