import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface TallyPriceEntry {
  itemName: string;
  sellingRate: number;
  costPrice?: number;
  unit: string;
}

interface TallyPriceListStore {
  entries: Record<string, TallyPriceEntry>; // keyed by itemName.toUpperCase()
  importedAt: string | null;
  itemCount: number;
  setPriceList: (entries: TallyPriceEntry[], importedAt: string) => void;
  clearPriceList: () => void;
}

export const useTallyPriceListStore = create<TallyPriceListStore>()(
  persist(
    (set) => ({
      entries: {},
      importedAt: null,
      itemCount: 0,
      setPriceList: (entries, importedAt) => {
        const map: Record<string, TallyPriceEntry> = {};
        for (const e of entries) {
          map[e.itemName.toUpperCase()] = e;
        }
        set({ entries: map, importedAt, itemCount: entries.length });
      },
      clearPriceList: () => set({ entries: {}, importedAt: null, itemCount: 0 }),
    }),
    { name: "mk_tally_pricelist" }
  )
);
