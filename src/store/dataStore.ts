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
    const items = new Map([...cur.items, ...newData.items]);
    const ledgers = new Map([...cur.ledgers, ...newData.ledgers]);
    const vMap = new Map<string, CanonicalVoucher>();
    for (const v of [...cur.vouchers, ...newData.vouchers]) {
      if (!vMap.has(v.voucherId)) vMap.set(v.voucherId, v);
    }
    const mergedRawData: ParsedData = {
      company: newData.company ?? cur.company,
      items,
      ledgers,
      vouchers: Array.from(vMap.values()),
      importedAt: new Date().toISOString(),
      sourceFiles: [...new Set([...cur.sourceFiles, ...newData.sourceFiles])],
      warnings: [...cur.warnings, ...newData.warnings],
    };
    get().setData(mergedRawData);
  },
}));
