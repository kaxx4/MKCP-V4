import { create } from "zustand";
import type { ParsedData, CanonicalVoucher } from "../types/canonical";

interface DataState {
  data: ParsedData | null;
  setData: (d: ParsedData) => void;
  mergeData: (d: ParsedData) => void;
  clearData: () => void;
}

export const useDataStore = create<DataState>((set, get) => ({
  data: null,
  setData: (data) => set({ data }),
  clearData: () => set({ data: null }),
  mergeData: (newData) => {
    const cur = get().data;
    if (!cur) {
      set({ data: newData });
      return;
    }
    const items = new Map([...cur.items, ...newData.items]);
    const ledgers = new Map([...cur.ledgers, ...newData.ledgers]);
    const vMap = new Map<string, CanonicalVoucher>();
    for (const v of [...cur.vouchers, ...newData.vouchers]) {
      if (!vMap.has(v.voucherId)) vMap.set(v.voucherId, v);
    }
    set({
      data: {
        company: newData.company ?? cur.company,
        items,
        ledgers,
        vouchers: Array.from(vMap.values()),
        importedAt: new Date().toISOString(),
        sourceFiles: [...new Set([...cur.sourceFiles, ...newData.sourceFiles])],
        warnings: [...cur.warnings, ...newData.warnings],
      },
    });
  },
}));
