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

// Default color palette for categories (10 colors)
const DEFAULT_CATEGORY_COLORS = [
  { bg: "bg-blue-50", border: "border-blue-400", pct: "text-blue-700", badge: "bg-blue-100 text-blue-800" },
  { bg: "bg-indigo-50", border: "border-indigo-400", pct: "text-indigo-700", badge: "bg-indigo-100 text-indigo-800" },
  { bg: "bg-violet-50", border: "border-violet-400", pct: "text-violet-700", badge: "bg-violet-100 text-violet-800" },
  { bg: "bg-amber-50", border: "border-amber-400", pct: "text-amber-700", badge: "bg-amber-100 text-amber-800" },
  { bg: "bg-orange-50", border: "border-orange-400", pct: "text-orange-700", badge: "bg-orange-100 text-orange-800" },
  { bg: "bg-cyan-50", border: "border-cyan-400", pct: "text-cyan-700", badge: "bg-cyan-100 text-cyan-800" },
  { bg: "bg-teal-50", border: "border-teal-400", pct: "text-teal-700", badge: "bg-teal-100 text-teal-800" },
  { bg: "bg-rose-50", border: "border-rose-400", pct: "text-rose-700", badge: "bg-rose-100 text-rose-800" },
  { bg: "bg-fuchsia-50", border: "border-fuchsia-400", pct: "text-fuchsia-700", badge: "bg-fuchsia-100 text-fuchsia-800" },
  { bg: "bg-lime-50", border: "border-lime-400", pct: "text-lime-700", badge: "bg-lime-100 text-lime-800" },
];

export function getCategoryColorByIndex(index: number): { bg: string; border: string; pct: string; badge: string } {
  return DEFAULT_CATEGORY_COLORS[index % DEFAULT_CATEGORY_COLORS.length];
}
