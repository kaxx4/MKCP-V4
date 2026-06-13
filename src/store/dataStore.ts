import { create } from "zustand";
import type { ParsedData, CanonicalVoucher } from "../types/canonical";
import { applyOverridesToItems } from "../utils/applyOverrides";
import { useOverrideStore } from "./overrideStore";
import { generatePredictions, scorePredictions, generateItemForecasts, type PredictionSnapshot } from "../engine/prediction";
import { saveToStore, loadFromStore } from "../db/idb";
import { buildVoucherIndex, getCurrentStockIndexed, type VoucherIndex } from "../engine/inventory";
import { computeItemMargins, type ItemMarginData } from "../engine/financial";
import { computePartyStats, type PartyStats } from "../utils/partyStats";

/** Pre-computed running-balance row for a single ledger. */
export interface LedgerTxn {
  date: string;
  voucherNumber: string;
  type: string;
  debit: number;
  credit: number;
  running: number;
}

interface DataState {
  data: ParsedData | null;
  rawData: ParsedData | null; // Store original data without overrides
  voucherIndex: VoucherIndex;
  /** Pre-computed item margins — populated in background after each data load.
   *  Null until the first background computation finishes. */
  itemMargins: Map<string, ItemMarginData> | null;
  /** Current stock per itemId — populated synchronously after every setData/mergeData.
   *  Replaces O(items × vouchers) loops in Dashboard/Orders/Alerts/Reports pages. */
  stockMap: Map<string, number>;
  /** Sorted transaction history with running balance per ledgerId — populated
   *  in idle callback. Replaces O(vouchers × lines) recompute per ledger click. */
  ledgerTransactionMap: Map<string, LedgerTxn[]>;
  /** Pre-computed party RFM/churn/prediction stats — populated in idle callback.
   *  Null until first compute finishes. Eliminates Outreach page's 1-2s mount freeze. */
  partyStats: PartyStats[] | null;
  setData: (d: ParsedData) => void;
  mergeData: (d: ParsedData) => void;
  /** Replace the Delivery Note vouchers in [fromISO, toISO] with the freshly-pulled set:
   *  drop every existing in-window DN, then re-add only the Delivery Notes from
   *  `freshVouchers` (other voucher types in the pull are ignored — full/day-book syncs
   *  own those). Used by the DN refresh so fulfilled/cancelled DNs that vanished from
   *  Tally drop off Pending Orders (plain mergeData never removes stale vouchers).
   *  Falls back to a merge if no data exists yet. */
  replaceDeliveryNotesInRange: (freshVouchers: CanonicalVoucher[], fromISO: string, toISO: string) => void;
  clearData: () => void;
  refreshOverrides: () => void; // Apply current overrides to raw data
}

/** Build a stock map for every item in one pass.
 *  Calls the existing `getCurrentStockIndexed` engine function (untouched). */
function buildStockMap(items: Map<string, any>, voucherIndex: VoucherIndex): Map<string, number> {
  const map = new Map<string, number>();
  for (const item of items.values()) {
    map.set(item.itemId, getCurrentStockIndexed(item, voucherIndex));
  }
  return map;
}

/** Build per-ledger transaction history with running balance.
 *  Single pass through all vouchers: O(vouchers × lines) once total,
 *  vs the previous per-ledger-click recompute. */
function buildLedgerTransactionMap(
  vouchers: CanonicalVoucher[],
  ledgers: Map<string, any>
): Map<string, LedgerTxn[]> {
  // Bucket lines by ledgerId in date order
  const buckets = new Map<string, Array<{ v: CanonicalVoucher; debit: number; credit: number }>>();

  // Pre-sort vouchers once
  const sorted = [...vouchers]
    .filter((v) => !v.isCancelled)
    .sort((a, b) => a.date.localeCompare(b.date));

  for (const v of sorted) {
    for (const line of v.lines) {
      if (line.type !== "ledger" || !line.ledgerId) continue;
      const debit = line.isDebit ? (line.amount ?? 0) : 0;
      const credit = !line.isDebit ? (line.amount ?? 0) : 0;
      const arr = buckets.get(line.ledgerId);
      if (arr) arr.push({ v, debit, credit });
      else buckets.set(line.ledgerId, [{ v, debit, credit }]);
    }
  }

  // Compute running balance per bucket
  const result = new Map<string, LedgerTxn[]>();
  for (const [ledgerId, rows] of buckets) {
    const ledger = ledgers.get(ledgerId);
    let running = ledger?.openingBalance ?? 0;
    const txns: LedgerTxn[] = new Array(rows.length);
    for (let i = 0; i < rows.length; i++) {
      const { v, debit, credit } = rows[i];
      running += debit - credit;
      txns[i] = {
        date: v.date,
        voucherNumber: v.voucherNumber,
        type: v.voucherType,
        debit,
        credit,
        running,
      };
    }
    result.set(ledgerId, txns);
  }
  return result;
}

export const useDataStore = create<DataState>((set, get) => ({
  data: null,
  rawData: null,
  voucherIndex: new Map(),
  itemMargins: null,
  stockMap: new Map(),
  ledgerTransactionMap: new Map(),
  partyStats: null,

  setData: (rawData) => {
    // Store raw data and apply overrides
    const { units, rates } = useOverrideStore.getState();
    const itemsWithOverrides = applyOverridesToItems(rawData.items, units, rates);
    const newData = { ...rawData, items: itemsWithOverrides };
    const voucherIndex = buildVoucherIndex(newData.vouchers);
    // Pre-compute stock map synchronously (cheap with voucherIndex — ~559 lookups)
    const stockMap = buildStockMap(itemsWithOverrides, voucherIndex);

    set({
      rawData,
      data: newData,
      voucherIndex,
      stockMap,
      itemMargins: null, // reset — will be re-populated below
      ledgerTransactionMap: new Map(), // reset — populated in idle callback below
      partyStats: null, // reset — populated in idle callback below
    });

    // Pre-compute ledger transaction map in idle callback — heavy single pass,
    // but eliminates the 1-2s freeze per ledger click on Ledgers page.
    const computeLedgerTxns = () => {
      const map = buildLedgerTransactionMap(newData.vouchers, newData.ledgers);
      set({ ledgerTransactionMap: map });
    };
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(computeLedgerTxns);
    } else {
      setTimeout(computeLedgerTxns, 100);
    }

    // Pre-compute party RFM/churn stats in idle callback — eliminates Outreach
    // page's 1-2s freeze on mount.
    const computePartyStatsAsync = () => {
      const stats = computePartyStats(newData.vouchers, newData.ledgers);
      set({ partyStats: stats });
    };
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(computePartyStatsAsync);
    } else {
      setTimeout(computePartyStatsAsync, 150);
    }

    // Pre-compute item margins in background so PendingOrders can read them
    // without running O(items × vouchers) on every navigation.
    const computeMargins = () => {
      const margins = computeItemMargins(newData.items, newData.vouchers);
      set({ itemMargins: new Map(margins.map((m) => [m.itemId, m])) });
    };
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(computeMargins);
    } else {
      setTimeout(computeMargins, 100);
    }

    // Run audit in development mode (Phase 5.1)
    if ((import.meta as any).env?.DEV) {
      // Dynamically import audit module to avoid circular dependencies
      import("../engine/audit").then(({ auditAllItems }) => {
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

  clearData: () => set({
    data: null,
    rawData: null,
    voucherIndex: new Map(),
    itemMargins: null,
    stockMap: new Map(),
    ledgerTransactionMap: new Map(),
    partyStats: null,
  }),

  refreshOverrides: () => {
    const { rawData, voucherIndex } = get();
    if (!rawData) return;
    const { units, rates } = useOverrideStore.getState();
    const itemsWithOverrides = applyOverridesToItems(rawData.items, units, rates);
    // Stock depends on item units/rates only via display conversion (stock is qtyBase),
    // but rebuild for correctness so any consumer reading from cache stays consistent.
    const stockMap = buildStockMap(itemsWithOverrides, voucherIndex);
    set({ data: { ...rawData, items: itemsWithOverrides }, stockMap });
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
    // New vouchers overwrite duplicates (same voucherId)
    let newCount = 0;
    let dupeCount = 0;
    for (const v of newData.vouchers) {
      if (vMap.has(v.voucherId)) {
        dupeCount++;
      } else {
        newCount++;
      }
      vMap.set(v.voucherId, v); // always take newest version
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
      ],
    };
    get().setData(mergedRawData);

    // Auto-regenerate predictions after merge (Task 3E)
    // Defer to idle callback / setTimeout so we don't block the UI render
    const deferredPredictions = () => (async () => {
      try {
        const { units, rates } = useOverrideStore.getState();
        const itemsWithOverrides = applyOverridesToItems(items, units, rates);

        // Load previous predictions for accuracy scoring
        const prevSnapshot = await loadFromStore<PredictionSnapshot>("predictions", "latest");

        // Generate new predictions for both types
        const salesPredictions = generatePredictions(allVouchers, itemsWithOverrides, "Sales");
        const purchasePredictions = generatePredictions(allVouchers, itemsWithOverrides, "Purchase");
        const allPredictions = [...salesPredictions, ...purchasePredictions];

        // Generate item-level forecasts and inventory alerts
        const { forecasts: itemForecasts, alerts: inventoryAlerts } = generateItemForecasts(
          allVouchers, itemsWithOverrides
        );

        const newSnapshot: PredictionSnapshot = {
          generatedAt: new Date().toISOString(),
          predictions: allPredictions,
          itemForecasts,
          inventoryAlerts,
        };

        // Score previous predictions against new actuals
        if (prevSnapshot && prevSnapshot.predictions.length > 0) {
          // Build a party→voucherType map for O(1) lookup instead of O(n*m)
          const partyTypeMap = new Map<string, "Sales" | "Purchase">();
          for (const v of allVouchers) {
            if (v.isCancelled || !v.partyLedgerId) continue;
            if (v.voucherType === "Sales" || v.voucherType === "Purchase") {
              if (!partyTypeMap.has(v.partyLedgerId)) {
                partyTypeMap.set(v.partyLedgerId, v.voucherType);
              }
            }
          }

          const salesAccuracy = scorePredictions(
            prevSnapshot.predictions.filter(p => partyTypeMap.get(p.partyLedgerId) === "Sales"),
            allVouchers,
            "Sales"
          );
          const purchaseAccuracy = scorePredictions(
            prevSnapshot.predictions.filter(p => partyTypeMap.get(p.partyLedgerId) === "Purchase"),
            allVouchers,
            "Purchase"
          );
          const allAccuracy = [...salesAccuracy, ...purchaseAccuracy];
          const today = new Date().toISOString().slice(0, 10);
          await saveToStore("predictions", `accuracy_${today}`, allAccuracy);

          // Save to prediction history (last 10 snapshots)
          const history = (await loadFromStore<PredictionSnapshot[]>("predictions", "history")) ?? [];
          history.push(prevSnapshot);
          if (history.length > 10) history.splice(0, history.length - 10);
          await saveToStore("predictions", "history", history);
        }

        // Save new predictions
        await saveToStore("predictions", "latest", newSnapshot);
      } catch {
        // Silently fail - predictions are non-critical
      }
    })();
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(deferredPredictions);
    } else {
      setTimeout(deferredPredictions, 100);
    }
  },

  replaceDeliveryNotesInRange: (freshVouchers, fromISO, toISO) => {
    const cur = get().rawData;
    // No existing dataset — fall back to a plain merge (nothing to "replace" against).
    if (!cur) {
      get().mergeData({
        company: null,
        items: new Map(),
        ledgers: new Map(),
        vouchers: freshVouchers,
        importedAt: new Date().toISOString(),
        sourceFiles: ["delivery-note-refresh"],
        warnings: [],
      });
      return;
    }

    const vMap = new Map<string, CanonicalVoucher>();
    let droppedInRange = 0;
    for (const v of cur.vouchers) {
      // Drop existing in-window Delivery Notes — the fresh pull is authoritative for
      // this window, so any DN no longer present in Tally must disappear here.
      if (v.voucherType === "Delivery Note" && v.date >= fromISO && v.date <= toISO) {
        droppedInRange++;
        continue;
      }
      vMap.set(v.voucherId, v);
    }
    // Re-add ONLY the freshly pulled Delivery Notes, overwriting by voucherId. We
    // deliberately ignore other voucher types in the pull: this is a DN-scoped refresh,
    // and the full/day-book syncs own Sales/Purchase/Receipt/Payment — overwriting those
    // here with a 90-day day-book chunk could clobber more-complete data.
    let freshDN = 0;
    for (const v of freshVouchers) {
      if (v.voucherType !== "Delivery Note") continue;
      freshDN++;
      vMap.set(v.voucherId, v);
    }

    const allVouchers = Array.from(vMap.values()).sort((a, b) => a.date.localeCompare(b.date));

    const rebuilt: ParsedData = {
      ...cur,
      vouchers: allVouchers,
      importedAt: new Date().toISOString(),
      sourceFiles: [...new Set([...cur.sourceFiles, "delivery-note-refresh"])],
      warnings: [
        ...cur.warnings,
        {
          severity: "info",
          context: "dn-refresh",
          message: `Delivery-note refresh: replaced ${droppedInRange} in-window DN(s) with ${freshDN} from Tally`,
        },
      ],
    };
    get().setData(rebuilt);
  },
}));
