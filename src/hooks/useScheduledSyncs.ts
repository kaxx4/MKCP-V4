import { useEffect, useRef } from "react";
import { useTallyStore } from "../store/tallyStore";
import { runQuickSync } from "../services/quickSync";
import { todayYmd, daysAgoYmd } from "../services/tallyPull";

/**
 * The ONLY automatic sync system. Three scheduled quick syncs, each = pull from
 * Tally (daily) for its window then push to Supabase:
 *   • Today      — every `syncTodayMinutes`
 *   • Last 7 days — every `syncWeekMinutes`
 *   • This FY    — every `syncFyMinutes`
 * Each interval is customizable; 0 disables that one. They share the global sync
 * lock, so they never overlap and the push never collides with a pull.
 */
export function useScheduledSyncs() {
  const todayMin = useTallyStore((s) => s.syncTodayMinutes);
  const weekMin  = useTallyStore((s) => s.syncWeekMinutes);
  const fyMin    = useTallyStore((s) => s.syncFyMinutes);
  const isConnected = useTallyStore((s) => s.isConnected);
  const companyName = useTallyStore((s) => s.companyName);
  const fyFromDate  = useTallyStore((s) => s.fyFromDate);

  const connRef = useRef(isConnected);
  useEffect(() => { connRef.current = isConnected; }, [isConnected]);
  const companyRef = useRef(companyName);
  useEffect(() => { companyRef.current = companyName; }, [companyName]);
  const fyFromRef = useRef(fyFromDate);
  useEffect(() => { fyFromRef.current = fyFromDate; }, [fyFromDate]);

  useEffect(() => {
    const fire = (label: string, from: () => string) => {
      if (!connRef.current || !companyRef.current.trim()) return;
      void runQuickSync(companyRef.current, label, from(), todayYmd(), true);
    };

    const timers: ReturnType<typeof setInterval>[] = [];
    if (todayMin > 0) timers.push(setInterval(() => fire("Today",       () => todayYmd()),     todayMin * 60_000));
    if (weekMin  > 0) timers.push(setInterval(() => fire("Last 7 days", () => daysAgoYmd(6)),  weekMin  * 60_000));
    if (fyMin    > 0) timers.push(setInterval(() => fire("This FY",     () => fyFromRef.current), fyMin * 60_000));

    // One "Today" pass as soon as the Tally connection is actually established —
    // polls every 3s (Tally can be slow to answer right after launch) and fires
    // once, so a slow startup doesn't push the first sync out to the full interval.
    let didInitial = false;
    const initialPoll = setInterval(() => {
      if (didInitial) { clearInterval(initialPoll); return; }
      if (connRef.current && companyRef.current.trim()) {
        didInitial = true;
        clearInterval(initialPoll);
        fire("Today", () => todayYmd());
      }
    }, 3_000);

    console.log(`[scheduled-sync] today: ${todayMin || "off"}m · 7d: ${weekMin || "off"}m · FY: ${fyMin || "off"}m`);

    return () => {
      timers.forEach(clearInterval);
      clearInterval(initialPoll);
    };
  }, [todayMin, weekMin, fyMin]);
}
