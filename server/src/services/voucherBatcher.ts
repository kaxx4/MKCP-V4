import type { VoucherBatch } from "../types.js";
import { buildVoucherCountXml } from "./xmlBuilder.js";
import { tallyPost } from "../tally.js";
import { getMonthlyChunks } from "../tally.js";

const DEFAULT_MAX_BATCH_SIZE = 400; // ~1 month worth of vouchers; keeps Tally XML responses manageable
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Build smart batches by querying Tally for per-date voucher counts,
 * then greedily packing dates into batches of maxBatchSize.
 * Falls back to monthly chunking if the count query fails.
 */
export async function buildSmartBatches(
  tallyUrl: string,
  company: string,
  fromDate: string,
  toDate: string,
  maxBatchSize = DEFAULT_MAX_BATCH_SIZE,
  signal?: AbortSignal
): Promise<VoucherBatch[]> {
  try {
    const xml = buildVoucherCountXml(company, fromDate, toDate);
    const parsed = await tallyPost(tallyUrl, xml, 30_000, false, signal);

    // Extract per-date counts from the response
    const dateCounts = extractDateCounts(parsed);

    if (dateCounts.size === 0) {
      console.log("[VoucherBatcher] Count query returned 0 dates — falling back to monthly chunking");
      return monthlyFallback(fromDate, toDate);
    }

    console.log(`[VoucherBatcher] Got counts for ${dateCounts.size} dates, total vouchers: ${[...dateCounts.values()].reduce((a, b) => a + b, 0)}`);

    return packIntoBatches(dateCounts, maxBatchSize);
  } catch (e: any) {
    console.warn(`[VoucherBatcher] Smart count query failed: ${e.message} — falling back to monthly chunking`);
    return monthlyFallback(fromDate, toDate);
  }
}

/** Parse date→count map from Tally collection response */
function extractDateCounts(parsed: any): Map<string, number> {
  const result = new Map<string, number>();

  const root =
    parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION ??
    parsed?.ENVELOPE?.BODY?.DATA?.TALLYMESSAGE ??
    parsed?.ENVELOPE?.BODY?.DATA ??
    null;

  if (!root) return result;

  const vouchers = Array.isArray(root.VOUCHER)
    ? root.VOUCHER
    : root.VOUCHER
    ? [root.VOUCHER]
    : [];

  for (const v of vouchers) {
    // DATE may be a typed Tally object { "#text": "...", "@_TYPE": "Date" } in Collection responses
    const rawDateRaw = v.DATE ?? v["@_DATE"] ?? "";
    const rawDate: string = typeof rawDateRaw === "object" ? (rawDateRaw?.["#text"] ?? "") : String(rawDateRaw ?? "");
    if (!rawDate) continue;
    // Normalize to YYYYMMDD
    const date = rawDate.replace(/-/g, "").replace(/\//g, "");
    if (date.length !== 8) continue;
    result.set(date, (result.get(date) ?? 0) + 1);
  }

  return result;
}

/** Greedily pack consecutive dates into batches where sum(count) <= maxBatchSize */
function packIntoBatches(
  dateCounts: Map<string, number>,
  maxBatchSize: number
): VoucherBatch[] {
  const sorted = [...dateCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const batches: VoucherBatch[] = [];

  let batchStart: string | null = null;
  let batchEnd: string | null = null;
  let batchCount = 0;

  for (const [date, count] of sorted) {
    if (batchStart === null) {
      batchStart = date;
      batchEnd = date;
      batchCount = count;
    } else if (batchCount + count <= maxBatchSize) {
      batchEnd = date;
      batchCount += count;
    } else {
      // Flush current batch
      batches.push({
        from: batchStart,
        to: batchEnd!,
        label: formatBatchLabel(batchStart, batchEnd!),
        estimatedCount: batchCount,
      });
      batchStart = date;
      batchEnd = date;
      batchCount = count;
    }
  }

  // Flush last batch
  if (batchStart !== null) {
    batches.push({
      from: batchStart,
      to: batchEnd!,
      label: formatBatchLabel(batchStart, batchEnd!),
      estimatedCount: batchCount,
    });
  }

  console.log(`[VoucherBatcher] Smart batching: ${sorted.length} dates → ${batches.length} batches (max ${maxBatchSize}/batch)`);
  return batches;
}

/** Format a human-readable label for a batch */
function formatBatchLabel(from: string, to: string): string {
  if (from === to) {
    const d = parseInt(from.slice(6), 10);
    const m = MONTH_NAMES[parseInt(from.slice(4, 6), 10) - 1];
    const y = from.slice(0, 4);
    return `${d} ${m} ${y}`;
  }
  const fromM = MONTH_NAMES[parseInt(from.slice(4, 6), 10) - 1];
  const toM = MONTH_NAMES[parseInt(to.slice(4, 6), 10) - 1];
  if (from.slice(0, 6) === to.slice(0, 6)) {
    return `${parseInt(from.slice(6), 10)}–${parseInt(to.slice(6), 10)} ${fromM} ${from.slice(0, 4)}`;
  }
  return `${fromM} ${from.slice(0, 4)} – ${toM} ${to.slice(0, 4)}`;
}

/** Fallback: convert monthly chunks to VoucherBatch format */
function monthlyFallback(fromDate: string, toDate: string): VoucherBatch[] {
  return getMonthlyChunks(fromDate, toDate).map(c => ({
    from: c.from,
    to: c.to,
    label: c.label,
    estimatedCount: -1,
  }));
}
