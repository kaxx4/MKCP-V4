/**
 * Discount Store — persists discount categories, tiers, and item→category assignments.
 * All data is stored in Zustand with localStorage persistence.
 * Items not assigned to any category have 0% discount.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface DiscountTier {
  minQty: number;   // inclusive, in packages
  maxQty: number;   // inclusive (use Infinity for open-ended)
  discountPercent: number;
}

export interface DiscountCategory {
  name: string;
  tiers: DiscountTier[];
}

interface DiscountState {
  // category name → tiers
  categories: DiscountCategory[];
  // itemId (uppercase) → category name
  itemAssignments: Record<string, string>;

  // Actions
  setCategories: (cats: DiscountCategory[]) => void;
  addCategory: (name: string) => void;
  renameCategory: (oldName: string, newName: string) => void;
  deleteCategory: (name: string) => void;
  updateTiers: (categoryName: string, tiers: DiscountTier[]) => void;
  addTier: (categoryName: string, tier: DiscountTier) => void;
  removeTier: (categoryName: string, idx: number) => void;
  updateTier: (categoryName: string, idx: number, updates: Partial<DiscountTier>) => void;

  assignItem: (itemId: string, categoryName: string) => void;
  unassignItem: (itemId: string) => void;
  bulkAssignItems: (itemIds: string[], categoryName: string) => void;

  getDiscount: (itemId: string, qtyPkg: number) => number; // returns %
}

const DEFAULT_CATEGORIES: DiscountCategory[] = [
  { name: "CHAIN & FREEWHEEL TOGO/DLR", tiers: [{ minQty: 1, maxQty: 5, discountPercent: 0.5 }, { minQty: 6, maxQty: Infinity, discountPercent: 2 }] },
  { name: "CHAIN & FREEWHEEL BIRDI",    tiers: [{ minQty: 1, maxQty: 5, discountPercent: 0.5 }, { minQty: 6, maxQty: Infinity, discountPercent: 1 }] },
  { name: "BELL CROWN ALL TYPES",       tiers: [{ minQty: 1, maxQty: 4, discountPercent: 1 },   { minQty: 5, maxQty: Infinity, discountPercent: 2 }] },
  { name: "PUMP TOGO ALL TYPES",        tiers: [{ minQty: 1, maxQty: 4, discountPercent: 1 },   { minQty: 5, maxQty: Infinity, discountPercent: 2 }] },
  { name: "SPOKE ALL TYPES",            tiers: [{ minQty: 2, maxQty: 2, discountPercent: 2 }] },
  { name: "KW PRODUCTS",                tiers: [{ minQty: 1, maxQty: Infinity, discountPercent: 0.5 }] },
  { name: "LOCK HERD",                  tiers: [{ minQty: 1, maxQty: 4, discountPercent: 2 },   { minQty: 5, maxQty: Infinity, discountPercent: 3 }] },
  { name: "LOCK KIRAN",                 tiers: [{ minQty: 1, maxQty: 4, discountPercent: 2 },   { minQty: 5, maxQty: Infinity, discountPercent: 3 }] },
  { name: "LOCK EURO",                  tiers: [{ minQty: 1, maxQty: 4, discountPercent: 2 },   { minQty: 5, maxQty: Infinity, discountPercent: 3 }] },
  { name: "LOCK CROWN",                 tiers: [{ minQty: 1, maxQty: 4, discountPercent: 2 },   { minQty: 5, maxQty: Infinity, discountPercent: 3 }] },
  { name: "TOGO & DOLLAR SPARES",       tiers: [{ minQty: 1, maxQty: 9, discountPercent: 2 },   { minQty: 10, maxQty: Infinity, discountPercent: 3 }] },
  { name: "TOGO CYCLE RIMS",            tiers: [{ minQty: 1, maxQty: 9, discountPercent: 2 },   { minQty: 10, maxQty: 49, discountPercent: 1 }, { minQty: 50, maxQty: Infinity, discountPercent: 3 }] },
];

export const useDiscountStore = create<DiscountState>()(
  persist(
    (set, get) => ({
      categories: DEFAULT_CATEGORIES,
      itemAssignments: {},

      setCategories: (categories) => set({ categories }),

      addCategory: (name) => set((s) => {
        if (s.categories.find(c => c.name === name)) return s;
        return { categories: [...s.categories, { name, tiers: [] }] };
      }),

      renameCategory: (oldName, newName) => set((s) => {
        const categories = s.categories.map(c => c.name === oldName ? { ...c, name: newName } : c);
        const itemAssignments = { ...s.itemAssignments };
        for (const [id, cat] of Object.entries(itemAssignments)) {
          if (cat === oldName) itemAssignments[id] = newName;
        }
        return { categories, itemAssignments };
      }),

      deleteCategory: (name) => set((s) => {
        const categories = s.categories.filter(c => c.name !== name);
        const itemAssignments = { ...s.itemAssignments };
        for (const [id, cat] of Object.entries(itemAssignments)) {
          if (cat === name) delete itemAssignments[id];
        }
        return { categories, itemAssignments };
      }),

      updateTiers: (categoryName, tiers) => set((s) => ({
        categories: s.categories.map(c => c.name === categoryName ? { ...c, tiers } : c),
      })),

      addTier: (categoryName, tier) => set((s) => ({
        categories: s.categories.map(c =>
          c.name === categoryName ? { ...c, tiers: [...c.tiers, tier] } : c
        ),
      })),

      removeTier: (categoryName, idx) => set((s) => ({
        categories: s.categories.map(c =>
          c.name === categoryName ? { ...c, tiers: c.tiers.filter((_, i) => i !== idx) } : c
        ),
      })),

      updateTier: (categoryName, idx, updates) => set((s) => ({
        categories: s.categories.map(c =>
          c.name === categoryName
            ? { ...c, tiers: c.tiers.map((t, i) => i === idx ? { ...t, ...updates } : t) }
            : c
        ),
      })),

      assignItem: (itemId, categoryName) => set((s) => ({
        itemAssignments: { ...s.itemAssignments, [itemId.toUpperCase()]: categoryName },
      })),

      unassignItem: (itemId) => set((s) => {
        const itemAssignments = { ...s.itemAssignments };
        delete itemAssignments[itemId.toUpperCase()];
        return { itemAssignments };
      }),

      bulkAssignItems: (itemIds, categoryName) => set((s) => {
        const itemAssignments = { ...s.itemAssignments };
        for (const id of itemIds) itemAssignments[id.toUpperCase()] = categoryName;
        return { itemAssignments };
      }),

      getDiscount: (itemId, qtyPkg) => {
        const { categories, itemAssignments } = get();
        const catName = itemAssignments[itemId.toUpperCase()];
        if (!catName) return 0;
        const cat = categories.find(c => c.name === catName);
        if (!cat) return 0;
        const tier = cat.tiers.find(t => qtyPkg >= t.minQty && qtyPkg <= t.maxQty);
        return tier?.discountPercent ?? 0;
      },
    }),
    {
      name: "mkcycles-discounts",
      version: 1,
    }
  )
);
