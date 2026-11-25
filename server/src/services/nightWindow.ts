/**
 * JOB: say whether a heavy whole-year Tally read may START now.
 *
 * Owner ruling, 25-Nov-2026: the big catch-up (the ERP mirror's full run and
 * the old nightly full-year sync) starts only from 12:30 AM India time. Full
 * runs in the working day made TallyPrime sluggish for the typist (24-Nov: a
 * 134-minute sync gap; 25-Nov: full runs at 10:16 and 10:54). Small syncs
 * (incremental, today, live) keep running in the day.
 *
 * The slot runs from 00:30 to 05:00 India time so a failed or busy first try
 * can try again the same night; it never spills into the morning. India time
 * is read from the UTC clock (+5:30, no daylight saving), not the machine's
 * own time zone, so a laptop set to another zone still waits for the right hour.
 */
export const FULL_RUN_START_MIN = 30; // 00:30 IST
export const FULL_RUN_END_MIN = 5 * 60; // 05:00 IST, exclusive

/** Minutes past midnight, India time (0..1439). */
export function indiaMinuteOfDay(now: Date): number {
  return (now.getUTCHours() * 60 + now.getUTCMinutes() + 330) % 1440;
}

/** True when a full run may start: 00:30 up to (not including) 05:00 India time. */
export function inFullRunWindow(now: Date): boolean {
  const m = indiaMinuteOfDay(now);
  return m >= FULL_RUN_START_MIN && m < FULL_RUN_END_MIN;
}
