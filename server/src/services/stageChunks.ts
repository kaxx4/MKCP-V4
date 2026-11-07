/**
 * JOB: split rows into staging requests (review of thread 8, item 15). Shared by the mirror sync and the masters, so there is one rule.
 */
const STAGE_BATCH = 500;
/** A voucher row now carries its tally-shaped block, so 500 rows can be many megabytes. A request holds at most this many bytes of JSON. */
export const STAGE_MAX_BYTES = 1_500_000;

/**
 * Pure: split rows into requests of at most `maxRows` rows AND at most `maxBytes` of JSON. A single row bigger than the cap
 * goes alone (it cannot be split), so no row is ever dropped. Order is kept.
 */
export function stageChunks<T>(rows: readonly T[], maxRows = STAGE_BATCH, maxBytes = STAGE_MAX_BYTES): T[][] {
  const out: T[][] = [];
  let cur: T[] = []; let bytes = 0;
  for (const r of rows) {
    const b = Buffer.byteLength(JSON.stringify(r), "utf8") + 1;
    if (cur.length > 0 && (cur.length >= maxRows || bytes + b > maxBytes)) { out.push(cur); cur = []; bytes = 0; }
    cur.push(r); bytes += b;
  }
  if (cur.length) out.push(cur);
  return out;
}

