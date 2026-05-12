// src/store/discountStore.ts
import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  DEFAULT_DISCOUNT_CATEGORIES,
  DEFAULT_ITEM_CATEGORY_MAP,
  type DiscountCategory,
} from "../engine/discounts";

// Bump this whenever DEFAULT_DISCOUNT_CATEGORIES or DEFAULT_ITEM_CATEGORY_MAP change
// so existing persisted data is automatically migrated to the new defaults.
const SCHEMA_VERSION = 2;

interface DiscountStore {
  _schemaVersion: number;
  categories: DiscountCategory[];
  // Only stores USER OVERRIDES (delta from defaults). Static defaults live in discounts.ts.
  itemCategoryOverrides: Record<string, string>;
  setCategories: (cats: DiscountCategory[]) => void;
  setItemCategoryOverrides: (overrides: Record<string, string>) => void;
  resetToDefaults: () => void;
  hydrateFromFile: (data: { categories: DiscountCategory[]; itemCategoryOverrides: Record<string, string> }) => void;
}

export const useDiscountStore = create<DiscountStore>()(
  persist(
    (set) => ({
      _schemaVersion: SCHEMA_VERSION,
      categories: DEFAULT_DISCOUNT_CATEGORIES,
      itemCategoryOverrides: {},
      setCategories: (categories) => set({ categories }),
      setItemCategoryOverrides: (itemCategoryOverrides) => set({ itemCategoryOverrides }),
      resetToDefaults: () =>
        set({
          _schemaVersion: SCHEMA_VERSION,
          categories: DEFAULT_DISCOUNT_CATEGORIES,
          itemCategoryOverrides: {},
        }),
      hydrateFromFile: (data) =>
        set({
          _schemaVersion: SCHEMA_VERSION,
          categories: data.categories,
          itemCategoryOverrides: data.itemCategoryOverrides,
        }),
    }),
    {
      name: "mk_discount_rules",
      onRehydrateStorage: () => (state) => {
        // Migrate to new defaults if schema version is stale or missing
        if (!state || state._schemaVersion !== SCHEMA_VERSION) {
          useDiscountStore.setState({
            _schemaVersion: SCHEMA_VERSION,
            categories: DEFAULT_DISCOUNT_CATEGORIES,
            itemCategoryOverrides: {},
          });
        }
      },
    }
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
