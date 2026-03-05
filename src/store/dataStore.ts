import { create } from "zustand";
import type { ParsedData, CanonicalVoucher } from "../types/canonical";
import { applyOverridesToItems } from "../utils/applyOverrides";
import { useOverrideStore } from "./overrideStore";
import { generatePredictions, scorePredictions, type PredictionSnapshot } from "../engine/prediction";
import { saveToStore, loadFromStore } from "../db/idb";
import { buildVoucherIndex, type VoucherIndex } from "../engine/inventory";

interface DataState {
  data: ParsedData | null;
  rawData: ParsedData | null; // Store original data without overrides
  voucherIndex: VoucherIndex;
  setData: (d: ParsedData) => void;
  mergeData: (d: ParsedData) => void;
  clearData: () => void;
  refreshOverrides: () => void; // Apply current overrides to raw data
}

export const useDataStore = create<DataState>((set, get) => ({
  data: null,
  rawData: null,
  voucherIndex: new Map(),

  setData: (rawData) => {
    // Store raw data and apply overrides
    const { units, rates } = useOverrideStore.getState();
    const itemsWithOverrides = applyOverridesToItems(rawData.items, units, rates);
    const newData = { ...rawData, items: itemsWithOverrides };
    const voucherIndex = buildVoucherIndex(newData.vouchers);

    set({
      rawData,
      data: newData,
      voucherIndex,
    });

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

  clearData: () => set({ data: null, rawData: null, voucherIndex: new Map() }),

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

    // Merge items (new overwrites old for same key)
    const items = new Map([...cur.items, ...newData.items]);

    // Merge ledgers (new overwrites old for same key)
    const ledgers = new Map([...cur.ledgers, ...newData.ledgers]);

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
    // Run async to not block the merge
    (async () => {
      try {
        const { units, rates } = useOverrideStore.getState();
        const itemsWithOverrides = applyOverridesToItems(items, units, rates);

        // Load previous predictions for accuracy scoring
        const prevSnapshot = await loadFromStore<PredictionSnapshot>("predictions", "latest");

        // Generate new predictions for both types
        const salesPredictions = generatePredictions(allVouchers, itemsWithOverrides, "Sales");
        const purchasePredictions = generatePredictions(allVouchers, itemsWithOverrides, "Purchase");
        const allPredictions = [...salesPredictions, ...purchasePredictions];

        const newSnapshot: PredictionSnapshot = {
          generatedAt: new Date().toISOString(),
          predictions: allPredictions,
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
  },
}));
