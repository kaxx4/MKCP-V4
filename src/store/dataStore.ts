import { create } from "zustand";
import type { ParsedData, CanonicalVoucher, ImportWarning } from "../types/canonical";
import { applyOverridesToItems } from "../utils/applyOverrides";
import { useOverrideStore } from "./overrideStore";
import { buildVoucherIndex } from "../engine/inventory";

/** Mass-deletion sanity check for applyDailyPull: if a fresh pull for a given
 *  (day, voucherType) would remove more than this percentage of that day's
 *  existing records of that type, refuse the drop for that type/day and keep
 *  the existing records unchanged instead (see applyDailyPull below). */
const MASS_DELETE_THRESHOLD_PCT = 40;

interface DataState {
  data: ParsedData | null;
  rawData: ParsedData | null; // Store original data without overrides
  setData: (d: ParsedData) => void;
  mergeData: (d: ParsedData) => void;
  /** THE single voucher-clearing authority for a daily pull. Rule, no exceptions:
   *  for each ISO date in `succeededDaysISO`, every existing voucher dated on that
   *  day (any type) is dropped, then every voucher in `freshVouchers` dated on
   *  that day is added back. Days not in `succeededDaysISO` are never touched.
   *  Voucher type never determines which rule applies — the only exception is the
   *  mass-deletion sanity check (see MASS_DELETE_THRESHOLD_PCT), applied per
   *  (day, voucherType): if dropping would remove more than that percentage of a
   *  type's existing count for that day, that type/day is left unchanged instead
   *  and a "prune-guard-triggered" warning is recorded. `extraWarnings` are
   *  appended as-is (e.g. the caller's own incomplete-lines/regression
   *  findings) so they aren't silently dropped just because this path — not
   *  mergeData — is what actually persists the pull. */
  applyDailyPull: (freshVouchers: CanonicalVoucher[], succeededDaysISO: string[], extraWarnings?: ImportWarning[]) => void;
  clearData: () => void;
  refreshOverrides: () => void; // Apply current overrides to raw data
}

/** Line count used to judge which of two same-voucherId records is "more complete".
 *  CanonicalVoucher stores both ledger and inventory rows in one unified `lines`
 *  array (each tagged type: "ledger" | "inventory"), so total length is the count. */
function lineCount(v: CanonicalVoucher): number {
  return v.lines?.length ?? 0;
}

/** True if `a` has strictly more lines than `b`. Used to refuse a merge/replace
 *  that would silently drop ledger/inventory rows a voucher previously had —
 *  e.g. a chunk re-fetch that hit a partial/failed Tally response. */
function isMoreComplete(a: CanonicalVoucher, b: CanonicalVoucher): boolean {
  return lineCount(a) > lineCount(b);
}

/** Decide whether `incoming` may replace `existing` for the same voucherId.
 *  Allowed when incoming is at least as complete, or existing had zero lines
 *  and incoming has some. Refused only when incoming would strictly REGRESS
 *  a voucher that previously had lines down to fewer (most dangerously, to zero). */
function canReplace(existing: CanonicalVoucher, incoming: CanonicalVoucher): boolean {
  const existingLines = lineCount(existing);
  const incomingLines = lineCount(incoming);
  if (incomingLines >= existingLines) return true;
  return existingLines === 0 && incomingLines > 0;
}

/** Build sync-logs-visible warning for a refused replace. */
function mergeGuardWarning(v: CanonicalVoucher): { severity: "warn"; context: "merge-guard"; message: string } {
  return {
    severity: "warn",
    context: "merge-guard",
    message: `Kept existing (more complete) record for voucher ${v.voucherNumber || v.voucherId} ` +
      `(${v.date}) — incoming pull had fewer/zero ledger+inventory lines; discarded to avoid data loss.`,
  };
}

export const useDataStore = create<DataState>((set, get) => ({
  data: null,
  rawData: null,

  setData: (rawData) => {
    // Store raw data and apply overrides
    const { units, rates } = useOverrideStore.getState();
    const itemsWithOverrides = applyOverridesToItems(rawData.items, units, rates);
    const newData = { ...rawData, items: itemsWithOverrides };

    set({ rawData, data: newData });

    // Run audit in development mode (Phase 5.1)
    if ((import.meta as any).env?.DEV) {
      // Dynamically import audit module to avoid circular dependencies
      import("../engine/audit").then(({ auditAllItems }) => {
        const voucherIndex = buildVoucherIndex(newData.vouchers);
        const auditResults = auditAllItems(newData.items, newData.vouchers, voucherIndex);
        const failures = auditResults.filter((r) => Math.abs(r.discrepancy) > 1e-9);
        if (failures.length > 0) {
          console.error("[AUDIT] Inventory discrepancies found:", failures);
          console.table(
            failures.map((f) => ({
              Item: f.itemName,
              Opening: f.openingQtyBase,
              Inwards: f.totalInwards,
              Outwards: f.totalOutwards,
              Expected: f.expectedClosing,
              Computed: f.computedClosing,
              Discrepancy: f.discrepancy.toFixed(4),
            }))
          );
        } else {
          console.log(`[AUDIT] ✓ All ${auditResults.length} items pass inventory integrity check`);
        }
      }).catch((err) => {
        console.warn("[AUDIT] Failed to run audit:", err);
      });
    }
  },

  clearData: () => set({ data: null, rawData: null }),

  refreshOverrides: () => {
    const { rawData } = get();
    if (!rawData) return;
    const { units, rates } = useOverrideStore.getState();
    const itemsWithOverrides = applyOverridesToItems(rawData.items, units, rates);
    set({ data: { ...rawData, items: itemsWithOverrides } });
  },

  mergeData: (newData) => {
    const cur = get().rawData;
    if (!cur) {
      get().setData(newData);
      return;
    }

    // Merge items (new overwrites old for same key).
    // Iterate-and-set is ~2x faster than [...spread, ...spread] which
    // allocates intermediate arrays of size 2×N before constructing Map.
    const items = new Map(cur.items);
    for (const [k, v] of newData.items) items.set(k, v);

    // Merge ledgers (new overwrites old for same key)
    const ledgers = new Map(cur.ledgers);
    for (const [k, v] of newData.ledgers) ledgers.set(k, v);

    // Merge vouchers with deduplication tracking
    const vMap = new Map<string, CanonicalVoucher>();
    // Add existing first
    for (const v of cur.vouchers) {
      vMap.set(v.voucherId, v);
    }
    // New vouchers overwrite duplicates (same voucherId) — unless doing so would
    // strictly regress a voucher's ledger/inventory line count (see canReplace).
    let newCount = 0;
    let dupeCount = 0;
    const guardWarnings: ImportWarning[] = [];
    for (const v of newData.vouchers) {
      const existing = vMap.get(v.voucherId);
      if (existing) {
        dupeCount++;
        if (canReplace(existing, v)) {
          vMap.set(v.voucherId, v);
        } else {
          guardWarnings.push(mergeGuardWarning(v));
        }
      } else {
        newCount++;
        vMap.set(v.voucherId, v);
      }
    }

    // Sort vouchers by date for optimal access
    const allVouchers = Array.from(vMap.values())
      .sort((a, b) => a.date.localeCompare(b.date));

    const mergedRawData: ParsedData = {
      company: newData.company ?? cur.company,
      items,
      ledgers,
      vouchers: allVouchers,
      importedAt: new Date().toISOString(),
      sourceFiles: [...new Set([...cur.sourceFiles, ...newData.sourceFiles])],
      warnings: [
        ...cur.warnings,
        ...newData.warnings,
        {
          severity: "info",
          context: "merge",
          message: `Merged: ${newCount} new vouchers, ${dupeCount} duplicates skipped/updated`
        },
        ...guardWarnings,
      ],
    };
    get().setData(mergedRawData);
  },

  applyDailyPull: (freshVouchers, succeededDaysISO, extraWarnings = []) => {
    const cur = get().rawData;
    const daySet = new Set(succeededDaysISO);

    // No existing dataset — nothing to prune against; just load the fresh set
    // (restricted to the touched days, same as every other path here).
    if (!cur) {
      const seeded = freshVouchers.filter((v) => daySet.has(v.date));
      console.log(`[applyDailyPull] ${succeededDaysISO.length} day(s): seeding empty store with ${seeded.length} voucher(s)`);
      get().setData({
        company: null,
        items: new Map(),
        ledgers: new Map(),
        vouchers: seeded,
        importedAt: new Date().toISOString(),
        sourceFiles: ["daily-pull"],
        warnings: extraWarnings,
      });
      return;
    }

    // Bucket existing vouchers on a touched day by "date|voucherType" — the
    // mass-deletion check operates at this granularity. Vouchers on untouched
    // days are carried through unconditionally.
    type Key = string;
    const keyOf = (date: string, type: string): Key => `${date}|${type}`;
    const existingByDayType = new Map<Key, CanonicalVoucher[]>();
    const kept: CanonicalVoucher[] = [];
    for (const v of cur.vouchers) {
      if (!daySet.has(v.date)) { kept.push(v); continue; }
      const key = keyOf(v.date, v.voucherType);
      let arr = existingByDayType.get(key);
      if (!arr) { arr = []; existingByDayType.set(key, arr); }
      arr.push(v);
    }

    const freshByDayType = new Map<Key, CanonicalVoucher[]>();
    for (const v of freshVouchers) {
      if (!daySet.has(v.date)) continue; // safety filter — fresh should only ever cover touched days
      const key = keyOf(v.date, v.voucherType);
      let arr = freshByDayType.get(key);
      if (!arr) { arr = []; freshByDayType.set(key, arr); }
      arr.push(v);
    }

    const allKeys = new Set<Key>([...existingByDayType.keys(), ...freshByDayType.keys()]);
    const guardWarnings: ImportWarning[] = [];
    let totalDropped = 0;
    let totalReadded = 0;
    const guardTriggersByType = new Map<string, number>();

    for (const key of allKeys) {
      const sep = key.indexOf("|");
      const day = key.slice(0, sep);
      const type = key.slice(sep + 1);
      const existingList = existingByDayType.get(key) ?? [];
      const freshList = freshByDayType.get(key) ?? [];

      if (existingList.length === 0) {
        // Nothing existing of this type on this day — nothing to mass-delete, just add.
        kept.push(...freshList);
        totalReadded += freshList.length;
        continue;
      }

      const freshIds = new Set(freshList.map((v) => v.voucherId));
      const removedCount = existingList.filter((v) => !freshIds.has(v.voucherId)).length;
      const removalPct = (removedCount / existingList.length) * 100;

      if (removalPct > MASS_DELETE_THRESHOLD_PCT) {
        // Mass-deletion sanity check tripped: refuse to drop this type on this
        // day. Keep the existing records for that type unchanged — do not add
        // the fresh ones either, since we're not touching this type/day at all.
        kept.push(...existingList);
        guardTriggersByType.set(type, (guardTriggersByType.get(type) ?? 0) + 1);
        guardWarnings.push({
          severity: "warn",
          context: "prune-guard-triggered",
          message: `Refused to prune ${type} on ${day}: fresh pull would remove ${removedCount}/${existingList.length} ` +
            `(${removalPct.toFixed(0)}%) of existing records — over the ${MASS_DELETE_THRESHOLD_PCT}% mass-deletion threshold. Kept existing records unchanged.`,
        });
        continue;
      }

      // Under threshold: drop this type's existing records for this day (they're
      // simply not re-pushed to `kept`), add the fresh ones.
      totalDropped += existingList.length;
      kept.push(...freshList);
      totalReadded += freshList.length;
    }

    const guardTriggerCount = guardTriggersByType.size > 0
      ? Array.from(guardTriggersByType.values()).reduce((a, b) => a + b, 0)
      : 0;
    const byTypeSummary = Array.from(guardTriggersByType.entries())
      .map(([t, n]) => `${t}:${n}`)
      .join(", ");

    const allVouchers = kept.sort((a, b) => a.date.localeCompare(b.date));

    console.log(
      `[applyDailyPull] ${succeededDaysISO.length} day(s): ${totalDropped} dropped, ${totalReadded} re-added` +
      (guardTriggerCount > 0 ? `, ${guardTriggerCount} prune-guard trigger(s) [${byTypeSummary}]` : "")
    );

    get().setData({
      ...cur,
      vouchers: allVouchers,
      importedAt: new Date().toISOString(),
      sourceFiles: [...new Set([...cur.sourceFiles, "daily-pull"])],
      warnings: [
        ...cur.warnings,
        {
          severity: "info",
          context: "daily-pull",
          message: `Daily pull (${succeededDaysISO.length} day(s)): ${totalDropped} dropped, ${totalReadded} re-added` +
            (guardTriggerCount > 0 ? `, ${guardTriggerCount} prune-guard trigger(s) [${byTypeSummary}]` : ""),
        },
        ...guardWarnings,
        ...extraWarnings,
      ],
    });
  },
}));
