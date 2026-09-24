/**
 * Which master rows a masters pass actually changes, so `tally_sync_history`
 * can say so.
 *
 * ── Why (24-Sep-2026) ─────────────────────────────────────────────────────
 *
 * Voucher rows have carried `row_counts.changed` since 7b52519 (an AlterID
 * pre-image). Masters rows never did, so the web app treats every masters row
 * as "unknown, reload": 53 masters rows in the 24 h to 24-Sep, each costing
 * every open tab a ~3.5 MB dataset download, while the rows they upserted were
 * almost always byte-identical to what the mirror already held.
 *
 * Masters carry no AlterID in the mirror (tally_stock_items / tally_ledgers
 * have no alter_id column, checked 24-Sep-2026), so the pre-image is the row
 * itself: read what the mirror holds for these GUIDs, compare every column the
 * pass is about to write except `synced_at`, and write only what differs.
 *
 * Fail-open, exactly like the voucher path: when the pre-image cannot be read
 * (`prior === null`), every row is written and `changed` is OMITTED, never
 * zero. The web side reads a missing `changed` as "unknown, reload".
 *
 * Comparison is deliberately biased towards "changed": two values only match
 * when they stringify identically (objects with sorted keys), or when one side
 * is a JS number and the other its numeric string (a number written into a
 * text column, or a numeric column PostgREST returns as a number). A false
 * "changed" costs one upsert and one reload, which is what every pass did
 * before; a false "unchanged" would hide an edit, so nothing looser is used.
 *
 * A key whose NEW value is `undefined` is not compared: supabase-js drops it
 * from the upsert, so the stored value survives the write either way.
 *
 * Pure — no Supabase, no clock. Fixtures: server/scripts/test-sync-history-changed.ts.
 */

export interface MasterDiff<T> {
  /** Rows to upsert: new or different. Every row when `prior` is null. */
  toWrite: T[];
  /** How many rows differ from the mirror. Omitted when the pre-image is unknown. */
  changed?: number;
}

function stable(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "undefined";
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
    .join(",")}}`;
}

/** True when a stored value and a value about to be written say the same thing. */
export function sameMasterValue(next: unknown, stored: unknown): boolean {
  if (next === null || next === undefined) return stored === null || stored === undefined;
  if (stored === null || stored === undefined) return false;
  if (typeof next === "object" || typeof stored === "object") return stable(next) === stable(stored);
  if (String(next) === String(stored)) return true;
  if (typeof next === "number" || typeof stored === "number") {
    const a = Number(next);
    const b = Number(stored);
    return String(next).trim() !== "" && String(stored).trim() !== "" && Number.isFinite(a) && a === b;
  }
  return false;
}

export function diffMasterRows<T extends Record<string, unknown>>(
  rows: readonly T[],
  prior: ReadonlyMap<string, Record<string, unknown>> | null,
  keyOf: (row: T) => string = (r) => String(r.guid),
  ignore: ReadonlySet<string> = new Set(["synced_at"]),
): MasterDiff<T> {
  if (prior === null) return { toWrite: rows.slice() };
  const toWrite: T[] = [];
  for (const row of rows) {
    const held = prior.get(keyOf(row));
    if (!held || !rowMatches(row, held, ignore)) toWrite.push(row);
  }
  return { toWrite, changed: toWrite.length };
}

function rowMatches(row: Record<string, unknown>, held: Record<string, unknown>, ignore: ReadonlySet<string>): boolean {
  for (const k of Object.keys(row)) {
    if (ignore.has(k)) continue;
    const next = row[k];
    if (next === undefined) continue;
    if (!sameMasterValue(next, held[k])) return false;
  }
  return true;
}

/**
 * Sum per-table changed counts into one `row_counts.changed`. Unknown if ANY
 * table is unknown: a masters row saying "0 changed" while one table could not
 * be compared would be a lie by omission.
 */
export function sumChanged(parts: ReadonlyArray<number | undefined>): number | undefined {
  let total = 0;
  for (const p of parts) {
    if (typeof p !== "number" || !Number.isFinite(p)) return undefined;
    total += p;
  }
  return total;
}
