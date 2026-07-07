import { useTallyStore } from "../store/tallyStore";
import { useDataStore } from "../store/dataStore";
import { syncDayBook, fetchChangedVouchers } from "../api/tallyApi";
import { parseTransactions } from "../parser/transactionParser";
import { loadData, createBackup } from "../db/idb";
import { deserializeParsedData } from "../utils/serialize";
import type { CanonicalVoucher, VoucherType } from "../types/canonical";

/** Result of a Tally pull — drives the per-phase stats/indicators in the UI. */
export interface PullResult {
  ok: boolean;
  vouchers: number;
  chunksSucceeded: number;
  chunksTotal: number;
  chunksFailed: number;
  cleared: number;        // in-window vouchers removed because Tally no longer has them
  elapsedSeconds: number;
  error?: string;
  /** voucherIds that should have ledger/inventory lines (by voucherType) but came
   *  back with none — a partial-Tally-response symptom, not a legitimate empty
   *  voucher. Populated after the one auto-retry in quickSync's runQuickSync; if
   *  still non-empty, the caller/UI should keep surfacing it as unresolved. */
  incompleteVoucherIds?: string[];
}

/** Voucher types that always carry at least one ledger/inventory line in Tally.
 *  A voucher of one of these types with zero lines is a parse/fetch defect, not
 *  a legitimate empty voucher (unlike e.g. a bare Quotation). */
const TYPES_REQUIRING_LINES: ReadonlySet<VoucherType> = new Set([
  "Sales", "Purchase", "Receipt", "Payment", "Journal", "Contra",
]);

/** Vouchers of a line-bearing type with zero lines — cancelled vouchers are
 *  exempt since Tally may legitimately record them with no lines. */
function findIncompleteVouchers(vouchers: CanonicalVoucher[]): CanonicalVoucher[] {
  return vouchers.filter(
    (v) => !v.isCancelled && TYPES_REQUIRING_LINES.has(v.voucherType) && (v.lines?.length ?? 0) === 0
  );
}

function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}
export function todayYmd(): string { return ymd(new Date()); }
export function daysAgoYmd(daysBack: number): string {
  const d = new Date();
  d.setDate(d.getDate() - Math.max(0, daysBack));
  return ymd(d);
}
function toIso(yyyymmdd: string): string {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

/**
 * Pull vouchers from Tally for [fromYmd, toYmd] and merge into the local store.
 * The GLOBAL "a sync is running" lock (tallyStore.isSyncing) is owned by the
 * caller (runQuickSync) so it spans the whole pull+push, not just the pull.
 *
 * On a CLEAN pull (no failed chunks) the window is authoritative: vouchers Tally
 * no longer has are cleared. A partial pull falls back to a safe additive merge.
 */
export async function pullFromTally(
  company: string,
  fromYmd: string,
  toYmd: string,
  strategy: "daily" | "weekly" | "monthly" = "daily",
  origin?: string,
): Promise<PullResult> {
  if (!company?.trim()) {
    return { ok: false, vouchers: 0, chunksSucceeded: 0, chunksTotal: 0, chunksFailed: 0, cleared: 0, elapsedSeconds: 0, error: "No company configured" };
  }

  const tally = useTallyStore.getState();
  try {
    const result = await syncDayBook(company, fromYmd, toYmd, strategy, origin);
    const s = result.stats;
    const base = {
      chunksSucceeded: s?.chunksSucceeded ?? 0,
      chunksTotal: s?.chunksTotal ?? 0,
      chunksFailed: s?.chunksFailed ?? 0,
      elapsedSeconds: s?.elapsedSeconds ?? 0,
    };

    const pulled = result.data?.tallymessage?.length ?? 0;
    if (!result.success && pulled === 0) {
      return { ok: false, vouchers: 0, cleared: 0, ...base, error: result.error || (result.errors?.[0] ?? "Tally returned no data") };
    }

    const parsed = parseTransactions(result.data);

    const incomplete = findIncompleteVouchers(parsed.vouchers);
    if (incomplete.length > 0) {
      const dates = incomplete.map((v) => v.date).filter(Boolean).sort();
      console.warn(
        `[pull] ${incomplete.length} voucher(s) came back with zero ledger/inventory lines ` +
        `(${dates[0]} → ${dates[dates.length - 1]}) — likely a partial Tally response for this chunk.`
      );
      parsed.warnings.push({
        severity: "warn",
        context: "incomplete-lines",
        message: `${incomplete.length} voucher(s) parsed with zero lines: ${incomplete.map((v) => v.voucherNumber || v.voucherId).slice(0, 10).join(", ")}${incomplete.length > 10 ? "…" : ""}`,
      });
    }

    const existingRaw = await loadData<unknown>("parsedData");
    const existing = existingRaw ? deserializeParsedData(existingRaw) : null;
    if (existing) await createBackup(existingRaw, "pre-quick-sync");

    const before = existing?.vouchers.length ?? 0;
    const cleanPull = base.chunksFailed === 0;
    const ds = useDataStore.getState();

    if (cleanPull && existing) {
      ds.replaceVouchersInRange(parsed.vouchers, toIso(fromYmd), toIso(toYmd));
    } else if (parsed.vouchers.length) {
      ds.mergeData({
        company: existing?.company ?? { name: company, fyStartMonth: 4 },
        items: existing?.items ?? new Map(),
        ledgers: existing?.ledgers ?? new Map(),
        vouchers: parsed.vouchers,
        importedAt: new Date().toISOString(),
        sourceFiles: ["quick-sync"],
        warnings: parsed.warnings,
      });
    }

    // Net count change tells us how many stale vouchers were cleared (clean pull only).
    const after = useDataStore.getState().data?.vouchers.length ?? before;
    const cleared = cleanPull ? Math.max(0, (before + parsed.vouchers.length) - after) : 0;

    // ── Incremental edit catch-up (AlterID) ─────────────────────────────────
    // A date-windowed pull never re-fetches vouchers edited OUTSIDE [from,to], so
    // edits to old vouchers never reach the store (or Supabase). Tally bumps a
    // voucher's AlterID on every edit, so we re-pull everything changed since our
    // highest-seen AlterID and merge it by GUID. Best-effort — a failure here must
    // not fail the sync, and the watermark only exists once a prior pull has
    // stamped AlterIDs (0 → skip, the window pull above seeds them).
    try {
      const storeVouchers = useDataStore.getState().data?.vouchers ?? [];
      let sinceAlterId = 0;
      for (const v of storeVouchers) {
        if (typeof v.alterId === "number" && v.alterId > sinceAlterId) sinceAlterId = v.alterId;
      }
      if (sinceAlterId > 0) {
        const changed = await fetchChangedVouchers(company, sinceAlterId);
        const changedVouchers = changed.success && changed.data ? parseTransactions(changed.data).vouchers : [];
        if (changedVouchers.length) {
          useDataStore.getState().mergeData({
            company: existing?.company ?? { name: company, fyStartMonth: 4 },
            items: existing?.items ?? new Map(),
            ledgers: existing?.ledgers ?? new Map(),
            vouchers: changedVouchers,
            importedAt: new Date().toISOString(),
            sourceFiles: ["quick-sync:changed"],
            warnings: [],
          });
          console.log(`[pull] AlterID catch-up: merged ${changedVouchers.length} edited voucher(s)`);
        }
      }
    } catch (e) {
      console.warn(`[pull] AlterID catch-up skipped: ${(e as Error)?.message || e}`);
    }

    const dates = parsed.vouchers.map((v) => v.date).filter(Boolean).sort();
    tally.completeSyncWith(new Date().toISOString(), dates.length ? dates[dates.length - 1]! : null);

    return {
      ok: true, vouchers: parsed.vouchers.length, cleared, ...base,
      incompleteVoucherIds: incomplete.length > 0 ? incomplete.map((v) => v.voucherId) : undefined,
    };
  } catch (e: any) {
    return { ok: false, vouchers: 0, chunksSucceeded: 0, chunksTotal: 0, chunksFailed: 0, cleared: 0, elapsedSeconds: 0, error: e?.message || String(e) };
  }
}

/**
 * One targeted re-fetch for vouchers that came back with zero lines (see
 * findIncompleteVouchers). Re-runs the existing daily Collection query scoped to
 * just [minDate, maxDate] of the incomplete set and merges the result through
 * the same completeness-guarded mergeData (Task 1) — so a still-partial Tally
 * response can never regress what's already in the store, only improve it.
 *
 * Best-effort, single-pass: never throws, never loops. Returns the voucherIds
 * still missing lines after the retry (empty if all recovered).
 */
export async function retryIncompleteVouchers(
  company: string,
  incompleteVoucherIds: string[],
  parsedVouchers: CanonicalVoucher[],
  origin?: string,
): Promise<string[]> {
  const incompleteSet = new Set(incompleteVoucherIds);
  const dates = parsedVouchers
    .filter((v) => incompleteSet.has(v.voucherId))
    .map((v) => v.date)
    .filter(Boolean)
    .sort();
  if (dates.length === 0) return incompleteVoucherIds;

  const fromIso = dates[0]!;
  const toIso_ = dates[dates.length - 1]!;
  const fromYmd = fromIso.replace(/-/g, "");
  const toYmd = toIso_.replace(/-/g, "");

  try {
    const result = await syncDayBook(company, fromYmd, toYmd, "daily", origin);
    const reparsed = parseTransactions(result.data);
    if (reparsed.vouchers.length === 0) {
      console.warn(`[pull] Incomplete-voucher retry (${fromIso} → ${toIso_}) returned nothing — leaving as unresolved`);
      return incompleteVoucherIds;
    }

    const existingRaw = await loadData<unknown>("parsedData");
    const existing = existingRaw ? deserializeParsedData(existingRaw) : null;

    useDataStore.getState().mergeData({
      company: existing?.company ?? { name: company, fyStartMonth: 4 },
      items: existing?.items ?? new Map(),
      ledgers: existing?.ledgers ?? new Map(),
      vouchers: reparsed.vouchers,
      importedAt: new Date().toISOString(),
      sourceFiles: ["incomplete-voucher-retry"],
      warnings: [],
    });

    const stillIncomplete = findIncompleteVouchers(
      useDataStore.getState().data?.vouchers.filter((v) => incompleteSet.has(v.voucherId)) ?? []
    ).map((v) => v.voucherId);

    console.log(
      `[pull] Incomplete-voucher retry: ${incompleteVoucherIds.length - stillIncomplete.length}/${incompleteVoucherIds.length} recovered`
    );
    return stillIncomplete;
  } catch (e) {
    console.warn(`[pull] Incomplete-voucher retry failed: ${(e as Error)?.message || e}`);
    return incompleteVoucherIds;
  }
}
