import { create } from "zustand";
import type { ParsedData, CanonicalVoucher } from "../types/canonical";
import { applyOverridesToItems } from "../utils/applyOverrides";
import { useOverrideStore } from "./overrideStore";

interface DataState {
  data: ParsedData | null;
  rawData: ParsedData | null; // Store original data without overrides
  setData: (d: ParsedData) => void;
  mergeData: (d: ParsedData) => void;
  clearData: () => void;
  refreshOverrides: () => void; // Apply current overrides to raw data
}

export const useDataStore = create<DataState>((set, get) => ({
  data: null,
  rawData: null,

  setData: (rawData) => {
    // Store raw data and apply overrides
    const { units, rates } = useOverrideStore.getState();
    const itemsWithOverrides = applyOverridesToItems(rawData.items, units, rates);
    set({
      rawData,
      data: { ...rawData, items: itemsWithOverrides },
    });
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
  },
}));
