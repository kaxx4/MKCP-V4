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
// Bumped to 3 on 2026-05-23 when DEFAULT_DISCOUNT_CATEGORIES + ITEM_CATEGORY_MAP
// were re-seeded from src/data/discountDefaults.json. The onRehydrateStorage
// migration preserves user overrides (itemCategoryOverrides + categoryColors).
const SCHEMA_VERSION = 3;

interface DiscountStore {
  _schemaVersion: number;
  categories: DiscountCategory[];
  // Only stores USER OVERRIDES (delta from defaults). Static defaults live in discounts.ts.
  itemCategoryOverrides: Record<string, string>;
  categoryColors: Record<string, string>; // categoryId -> color (hex)
  setCategories: (cats: DiscountCategory[]) => void;
  setItemCategoryOverrides: (overrides: Record<string, string>) => void;
  setCategoryColor: (categoryId: string, color: string) => void;
  resetToDefaults: () => void;
  hydrateFromFile: (data: { categories: DiscountCategory[]; itemCategoryOverrides: Record<string, string>; categoryColors?: Record<string, string> }) => void;
}

export const useDiscountStore = create<DiscountStore>()(
  persist(
    (set) => ({
      _schemaVersion: SCHEMA_VERSION,
      categories: DEFAULT_DISCOUNT_CATEGORIES,
      itemCategoryOverrides: {},
      categoryColors: {},
      setCategories: (categories) => set({ categories }),
      setItemCategoryOverrides: (itemCategoryOverrides) => set({ itemCategoryOverrides }),
      setCategoryColor: (categoryId, color) =>
        set((state) => ({
          categoryColors: { ...state.categoryColors, [categoryId]: color },
        })),
      resetToDefaults: () =>
        set({
          _schemaVersion: SCHEMA_VERSION,
          categories: DEFAULT_DISCOUNT_CATEGORIES,
          itemCategoryOverrides: {},
          categoryColors: {},
        }),
      hydrateFromFile: (data) =>
        set({
          _schemaVersion: SCHEMA_VERSION,
          categories: data.categories,
          itemCategoryOverrides: data.itemCategoryOverrides,
          categoryColors: data.categoryColors ?? {},
        }),
    }),
    {
      name: "mk_discount_rules",
      onRehydrateStorage: () => (state) => {
        // Migrate to new defaults — preserve user overrides/colors across schema bumps.
        // Only categories are re-seeded; itemCategoryOverrides and categoryColors keep
        // user data so SCHEMA_VERSION bumps don't wipe customization.
        if (!state) {
          useDiscountStore.setState({
            _schemaVersion: SCHEMA_VERSION,
            categories: DEFAULT_DISCOUNT_CATEGORIES,
            itemCategoryOverrides: {},
            categoryColors: {},
          });
          return;
        }
        if (state._schemaVersion !== SCHEMA_VERSION) {
          // Prune categoryColors that reference categories no longer in defaults
          const validCategoryIds = new Set(DEFAULT_DISCOUNT_CATEGORIES.map((c) => c.id));
          const prunedColors = Object.fromEntries(
            Object.entries(state.categoryColors || {}).filter(([id]) => validCategoryIds.has(id))
          );
          useDiscountStore.setState({
            _schemaVersion: SCHEMA_VERSION,
            categories: DEFAULT_DISCOUNT_CATEGORIES,
            itemCategoryOverrides: state.itemCategoryOverrides || {},
            categoryColors: prunedColors,
          });
        }
      },
    }
  )
);
