// src/engine/discounts.ts
// Discount category defaults for MK Cycles.
//
// DEFAULTS source of truth: `src/data/discountDefaults.json`.
// The categories and item→category map below are imported from that JSON file
// (originally exported from the dashboard's Discount Rules → Export on
// 2026-05-23). To update defaults again, re-export from the UI and overwrite
// the JSON file. The user-facing Import / Export / Edit flow on the Discount
// Rules page is unaffected — it overlays these defaults via discountStore at
// runtime.
import discountDefaultsJson from "../data/discountDefaults.json";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DiscountTier {
  minQty: number;        // packages, inclusive
  maxQty: number | null; // packages, inclusive; null = unlimited
  discountPct: number;   // e.g. 2.0 = 2%
}

export interface DiscountCategory {
  id: string;    // stable slug used as map key
  name: string;  // display name (matches Excel exactly)
  tiers: DiscountTier[];
}

// ── Default Categories — sourced from src/data/discountDefaults.json ─────────
// 16 categories with tier breakpoints. To change, edit the JSON file.

export const DEFAULT_DISCOUNT_CATEGORIES: DiscountCategory[] =
  discountDefaultsJson.categories as DiscountCategory[];


// ── Default Item → Category Map — sourced from src/data/discountDefaults.json
// Key   = item name UPPERCASED (matches Tally `name.toUpperCase()`)
// Value = category name (matches DiscountCategory.name exactly)
// Items not in this map default to "No Discount".

export const DEFAULT_ITEM_CATEGORY_MAP: Record<string, string> =
  discountDefaultsJson.itemCategoryMap as Record<string, string>;
