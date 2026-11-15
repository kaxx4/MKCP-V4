/**
 * JOB: two guards of the ERP mirror's day windows (D-M.279): how far ahead of today a full run reads, and the "a whole voucher type vanished" check.
 *
 * Why. On 14-Nov-2026 the office re-dated open Sales Order Notes to 16-Nov, a day after the window the live sync read (up to today). The per-day prune
 * saw nothing on the old days and removed the notes; the new day was never read, so they were gone from the mirror. Two guards:
 *   1. a full run reads FORWARD days too, so a voucher dated ahead is mirrored on its new day while the old day is pruned;
 *   2. before a run's rows replace a window, a voucher type the mirror holds for that window that the read holds ZERO of, while other types are
 *      present, is an alarm and the swap is held: a whole type missing from a read is not "everything of that type was deleted".
 *
 * Pure: nothing here talks to Tally or the database.
 */

/**
 * How many days AFTER today a full run reads (one constant, D-M.279). A post-dated voucher is mirrored on its own day while it sits in the window.
 * 45 days covers the office's habit of dating work a few weeks ahead; the window never runs past the end of the financial year (Tally takes no
 * voucher beyond it), and the database refuses a scope over one year, which the year's own length never reaches.
 */
export const MIRROR_FORWARD_DAYS = 45;

const addDays = (iso: string, n: number): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * The scope of a full run: the financial year's 1 April to `today` + MIRROR_FORWARD_DAYS, but not past the year's last day (31 March).
 * `today` is the India date, YYYY-MM-DD.
 */
export function mirrorFullScope(today: string): { from: string; to: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error(`refused: ${today} is not a YYYY-MM-DD date`);
  const y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7));
  const startYear = m >= 4 ? y : y - 1;
  const from = `${startYear}-04-01`, fyEnd = `${startYear + 1}-03-31`;
  const ahead = addDays(today, MIRROR_FORWARD_DAYS);
  return { from, to: ahead < fyEnd ? ahead : fyEnd };
}

/** One alarm the mirror raises: what, why, and when. Shown on /api/primary/status and written to the journal. */
export interface MirrorAlarm {
  kind: "type_vanished";
  /** The voucher type that disappeared from the read. */
  type: string;
  /** How many rows of it the mirror holds for the window. */
  storeRows: number;
  /** Which window, and which piece of work noticed. */
  from: string;
  to: string;
  where: "full" | "repull" | "day_check";
  reason: string;
}

const norm = (t: string | null | undefined): string => String(t ?? "").trim().toLowerCase();

/**
 * Types the store holds for a window that the pull holds none of, while the pull holds other types. `store` and `pulled` are counts by voucher
 * type (case does not matter: the queue says Sales, Tally keeps SALES). A pull with nothing at all is NOT judged here (the floors and the empty-read
 * checks own that); neither is a type the store holds none of. Pure.
 */
export function vanishedTypes(store: Record<string, number>, pulled: Record<string, number>, win: { from: string; to: string; where: MirrorAlarm["where"] }): MirrorAlarm[] {
  const have = new Map<string, number>();
  for (const [t, n] of Object.entries(pulled)) have.set(norm(t), (have.get(norm(t)) ?? 0) + n);
  const pulledTotal = [...have.values()].reduce((a, b) => a + b, 0);
  if (pulledTotal <= 0) return [];
  const out: MirrorAlarm[] = [];
  const seen = new Set<string>();
  for (const [t, n] of Object.entries(store)) {
    const k = norm(t);
    if (!(n > 0) || seen.has(k) || (have.get(k) ?? 0) > 0) continue;
    seen.add(k);
    out.push({
      kind: "type_vanished", type: t.trim() || "(no type)", storeRows: n, from: win.from, to: win.to, where: win.where,
      reason: `the mirror holds ${n} ${t.trim() || "untyped"} voucher(s) for ${win.from} to ${win.to}, but Tally's read holds none of that type while it holds ${pulledTotal} of other types; a whole type missing is not "all deleted", so nothing was pruned and a person must look`,
    });
  }
  return out;
}

/** Counts of vouchers by type. */
export function countByType(list: { voucher_type?: string | null; type?: string | null }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of list) { const t = String(v.voucher_type ?? v.type ?? "").trim() || "(no type)"; out[t] = (out[t] ?? 0) + 1; }
  return out;
}
