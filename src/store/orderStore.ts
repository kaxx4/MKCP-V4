import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface OrderLine {
  itemId: string;
  itemName: string;
  baseUnit: string;
  pkgUnit: string | null;
  unitsPerPkg: number;
  qtyBase: number;    // always base units stored
  ratePerBase: number;
}

interface OrderState {
  lines: Record<string, OrderLine>; // key = itemId
  setLine: (itemId: string, line: OrderLine) => void;
  removeLine: (itemId: string) => void;
  clearAll: () => void;
  getAllLines: () => OrderLine[];
  totalValue: () => number;
}

export const useOrderStore = create<OrderState>()(
  persist(
    (set, get) => ({
      lines: {},
      setLine: (itemId, line) => set((s) => ({ lines: { ...s.lines, [itemId]: line } })),
      removeLine: (itemId) =>
        set((s) => {
          const { [itemId]: _, ...rest } = s.lines;
          return { lines: rest };
        }),
      clearAll: () => set({ lines: {} }),
      getAllLines: () => Object.values(get().lines),
      totalValue: () =>
        Object.values(get().lines).reduce((sum, l) => sum + l.qtyBase * l.ratePerBase, 0),
    }),
    { name: "mkcycles-orders" }
  )
);
