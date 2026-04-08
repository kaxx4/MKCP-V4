// src/store/discountStore.ts
import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  DEFAULT_DISCOUNT_CATEGORIES,
  DEFAULT_ITEM_CATEGORY_MAP,
  type DiscountCategory,
} from "../engine/discounts";

interface DiscountStore {
  categories: DiscountCategory[];
  // Only stores USER OVERRIDES (delta from defaults). Static defaults live in discounts.ts.
  itemCategoryOverrides: Record<string, string>;
  setCategories: (cats: DiscountCategory[]) => void;
  setItemCategoryOverrides: (overrides: Record<string, string>) => void;
  resetToDefaults: () => void;
}

export const useDiscountStore = create<DiscountStore>()(
  persist(
    (set) => ({
      categories: DEFAULT_DISCOUNT_CATEGORIES,
      itemCategoryOverrides: {},
      setCategories: (categories) => set({ categories }),
      setItemCategoryOverrides: (itemCategoryOverrides) => set({ itemCategoryOverrides }),
      resetToDefaults: () =>
        set({
          categories: DEFAULT_DISCOUNT_CATEGORIES,
          itemCategoryOverrides: {},
        }),
    }),
    { name: "mk_discount_rules" }
  )
);

/**
 * Returns the merged item->category map:
 * Static defaults overlaid with any user overrides.
 * Use this at calculation time, not the raw store values.
 */
export function getMergedCategoryMap(
  overrides: Record<string, string>
): Record<string, string> {
  return { ...DEFAULT_ITEM_CATEGORY_MAP, ...overrides };
}
