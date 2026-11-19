/**
 * JOB: decide which days of a "last N days" sync actually need a full read (A-3, owner 18-Nov-2026: "faster, selective, efficient,
 * but don't break anything").
 *
 * Measured 19-Nov-2026 on the laptop's dummy Tally (server/scripts/probe-day-fingerprint.ts): every date-filtered voucher request
 * costs about 15 s there whatever it returns (an empty day as much as a busy one; the office computer measured about 4 s), because
 * Tally scans every voucher to apply the filter. A 7-day sync made 7 such requests (111 s). One request for Guid, Date and AlterID
 * over the whole window cost 16 s and listed exactly the same vouchers. So: read that "fingerprint" once, compare each day with the
 * mirror, and fully read only the days that differ.
 *
 * A day is SKIPPED only when Tally and the mirror list exactly the same vouchers with exactly the same AlterID, and none is blank.
 * Everything else is read in full as before: a voucher only one side has (new, deleted, or moved to another date), a changed AlterID
 * (any edit in Tally moves it), a blank AlterID on either side (the mirror blanks it when a voucher's lines did not land). Doubt
 * always means "read the day". Pure; the I/O lives in the orchestrator and SupabaseSync.
 */

/** day (YYYYMMDD) -> guid -> AlterID (null = blank). */
export type DayPrints = Map<string, Map<string, number | null>>;

/** "2026-11-19", "20261119" or "19-Nov-2026"-style input is not accepted: only the two machine forms. */
export function dayKey(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (/^\d{8}$/.test(s)) return s;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? `${m[1]}${m[2]}${m[3]}` : null;
}

export function alterOf(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/** Build day prints from rows with a guid, a date and an AlterID. A row with no guid or no readable date makes the result null
 *  (cannot tell), never a smaller set. */
export function buildPrints(rows: ReadonlyArray<{ guid?: unknown; date?: unknown; alterId?: unknown }>): DayPrints | null {
  const out: DayPrints = new Map();
  for (const r of rows) {
    const g = String(r.guid ?? "").trim();
    const d = dayKey(r.date);
    if (!g || !d) return null;
    let day = out.get(d);
    if (!day) { day = new Map(); out.set(d, day); }
    day.set(g, alterOf(r.alterId));
  }
  return out;
}

function sameDay(a: Map<string, number | null> | undefined, b: Map<string, number | null> | undefined): boolean {
  const A = a ?? new Map(), B = b ?? new Map();
  if (A.size !== B.size) return false;
  for (const [g, alt] of A) {
    if (!B.has(g)) return false;
    const other = B.get(g);
    if (alt === null || other === null || alt !== other) return false;
  }
  return true;
}

/**
 * The days (from `days`, kept in order) that need a full read. `tally` null or `mirror` null means "could not tell": every day.
 * A Tally fingerprint with no voucher at all across the window is not trusted either (an empty reply never means "nothing there"):
 * every day.
 */
export function daysToRead(days: readonly string[], tally: DayPrints | null, mirror: DayPrints | null): string[] {
  if (!tally || !mirror) return [...days];
  let tallyCount = 0;
  for (const d of tally.values()) tallyCount += d.size;
  if (tallyCount === 0) return [...days];
  return days.filter((d) => !sameDay(tally.get(d), mirror.get(d)));
}
