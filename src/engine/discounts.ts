// src/engine/discounts.ts
// Discount engine for MK Cycles.
//
// DEFAULTS source of truth: `src/data/discountDefaults.json`.
// The categories, tiers, item→category map, and group rules below are
// imported from that JSON file (originally exported from the dashboard's
// Discount Rules → Export on 2026-05-23). To update defaults again,
// re-export from the UI and overwrite the JSON file. The user-facing
// Import / Export / Edit flow on the Discount Rules page is unaffected —
// it overlays these defaults via discountStore at runtime.
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

export interface LineDiscountResult {
  itemName: string;
  qtyBase: number;
  unitsPerPkg: number;
  packages: number;
  lineAmount: number;
  categoryId: string;
  categoryName: string;
  discountPct: number;
  discountAmount: number;
  tierLabel: string;   // e.g. "1-9 pkgs -> 2%" or "No discount"
}

export interface GroupDiscountSummary {
  categoryId: string;
  categoryName: string;
  totalPackages: number;
  appliedDiscountPct: number;
  totalAmount: number;
  totalDiscount: number;
  groupRuleApplied?: string;  // name of rule applied, if any
  baseTierInfo?: string;      // base tier before rule upgrade
}

export interface VoucherDiscountResult {
  lines: LineDiscountResult[];
  groupSummaries: GroupDiscountSummary[]; // group-wise totals
  totalLineAmount: number;
  totalDiscountAmount: number;
  effectivePct: number; // totalDiscountAmount / totalLineAmount * 100
}

export interface GroupRule {
  id: string;
  name: string;
  categoryIds: string[];  // categories to combine
  minPackages: number;    // if combined packages >= this
  upgradeDiscountPct: number;  // upgrade all items in these categories to this %
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


// ── Group Rules — sourced from src/data/discountDefaults.json ────────────────
// Combo rules (e.g. LOCK_COMBO_10PKG: 10+ pkgs across all LOCK_* → 3%)

export const DEFAULT_GROUP_RULES: GroupRule[] =
  discountDefaultsJson.groupRules as GroupRule[];

// ── Lookup helper ─────────────────────────────────────────────────────────────

/**
 * Resolve the effective DiscountCategory for an item.
 * Lookup order:
 *   1. runtimeOverrides (user changes saved in store — keyed by itemId)
 *   2. DEFAULT_ITEM_CATEGORY_MAP (hardcoded from Excel)
 *   3. "No Discount" fallback
 *
 * itemId = item name uppercased and trimmed (matches CanonicalItem.itemId).
 */
export function resolveCategoryForItem(
  itemId: string,
  runtimeOverrides: Record<string, string>,
  categories: DiscountCategory[]
): DiscountCategory {
  const catName =
    runtimeOverrides[itemId] ??
    DEFAULT_ITEM_CATEGORY_MAP[itemId] ??
    "No Discount";

  return (
    categories.find((c) => c.name === catName) ??
    categories.find((c) => c.id === "NO_DISCOUNT") ??
    { id: "NO_DISCOUNT", name: "No Discount", tiers: [] }
  );
}

// ── Calculation engine (pure, no side effects) ────────────────────────────────

function matchTier(
  packages: number,
  category: DiscountCategory
): { discountPct: number; tierLabel: string } {
  for (const tier of category.tiers) {
    const aboveMin = packages >= tier.minQty;
    const belowMax = tier.maxQty === null || packages <= tier.maxQty;
    if (aboveMin && belowMax) {
      const maxStr = tier.maxQty === null ? "+" : `-${tier.maxQty}`;
      return {
        discountPct: tier.discountPct,
        tierLabel: `${tier.minQty}${maxStr} pkgs -> ${tier.discountPct}%`,
      };
    }
  }
  return { discountPct: 0, tierLabel: "No tier matched" };
}

export function calculateLineDiscount(params: {
  itemId: string;
  itemName: string;
  qtyBase: number;
  unitsPerPkg: number;
  lineAmount: number;
  runtimeOverrides: Record<string, string>;
  categories: DiscountCategory[];
}): LineDiscountResult {
  const { itemId, itemName, qtyBase, unitsPerPkg, lineAmount, runtimeOverrides, categories } = params;

  const upkg = unitsPerPkg > 0 ? unitsPerPkg : 1;
  const packages = qtyBase > 0 ? Math.max(1, Math.floor(qtyBase / upkg)) : 0;

  const category = resolveCategoryForItem(itemId, runtimeOverrides, categories);

  const { discountPct, tierLabel } =
    packages > 0 && category.tiers.length > 0
      ? matchTier(packages, category)
      : {
          discountPct: 0,
          tierLabel: category.tiers.length === 0 ? "No discount" : "Qty is 0",
        };

  return {
    itemName,
    qtyBase,
    unitsPerPkg: upkg,
    packages,
    lineAmount,
    categoryId: category.id,
    categoryName: category.name,
    discountPct,
    discountAmount: (lineAmount * discountPct) / 100,
    tierLabel,
  };
}

export function calculateVoucherDiscount(
  voucher: import("../types/canonical").CanonicalVoucher,
  items: Map<string, import("../types/canonical").CanonicalItem>,
  categories: DiscountCategory[],
  runtimeOverrides: Record<string, string>
): VoucherDiscountResult {
  console.log(`[DISCOUNT] ═══════════════════════════════════════════════════════════`);
  console.log(`[DISCOUNT] Calculating discounts for: ${voucher.voucherNumber} (${voucher.voucherType})`);

  // ─── Phase 1: Group items by category and collect line data ─────────────────

  interface LineInfo {
    itemName: string;
    qtyBase: number;
    unitsPerPkg: number;
    packages: number;
    lineAmount: number;
    categoryId: string;
    categoryName: string;
  }

  interface GroupInfo {
    categoryId: string;
    categoryName: string;
    lineIndices: number[];
    totalPackages: number;
    totalAmount: number;
  }

  const lineData: LineInfo[] = [];
  const groupMap = new Map<string, GroupInfo>();

  console.log(`[DISCOUNT] Phase 1: Grouping items by category...`);

  // First pass: collect all lines and group by category
  for (const line of voucher.lines) {
    if (line.type !== "inventory" || !line.itemId || (line.qtyBase ?? 0) === 0) continue;

    const item = items.get(line.itemId);
    const upkg = (item?.unitsPerPkg ?? 1) > 0 ? (item?.unitsPerPkg ?? 1) : 1;
    const qtyBase = line.qtyBase ?? 0;
    const packages = qtyBase > 0 ? Math.max(1, Math.floor(qtyBase / upkg)) : 0;
    const lineAmount = line.lineAmount ?? 0;

    const category = resolveCategoryForItem(line.itemId, runtimeOverrides, categories);

    // Store line data
    const lineIdx = lineData.length;
    lineData.push({
      itemName: item?.name ?? line.itemId,
      qtyBase,
      unitsPerPkg: upkg,
      packages,
      lineAmount,
      categoryId: category.id,
      categoryName: category.name,
    });

    console.log(`[DISCOUNT]   "${item?.name ?? line.itemId}": qty=${qtyBase}, upkg=${upkg}, pkgs=${packages}, cat=${category.name}`);

    // Accumulate by group
    const key = category.id;
    if (!groupMap.has(key)) {
      groupMap.set(key, {
        categoryId: category.id,
        categoryName: category.name,
        lineIndices: [],
        totalPackages: 0,
        totalAmount: 0,
      });
    }
    const group = groupMap.get(key)!;
    group.lineIndices.push(lineIdx);
    group.totalPackages += packages;
    group.totalAmount += lineAmount;
  }

  console.log(`[DISCOUNT] Phase 1 Complete. Groups formed:`, Array.from(groupMap.values()).map((g) => ({
    name: g.categoryName,
    pkgs: g.totalPackages,
    amt: g.totalAmount,
  })));

  // ─── Phase 2: Determine discount % per group based on total packages ─────────
  // Then apply that % to all items in the group

  const lines: LineDiscountResult[] = [];
  const groupSummaries: GroupDiscountSummary[] = [];

  console.log(`[DISCOUNT] Phase 2: Determining discounts per group...`);

  for (const group of groupMap.values()) {
    // Find category definition
    const category = categories.find((c) => c.id === group.categoryId) ||
                     { id: "NO_DISCOUNT", name: "No Discount", tiers: [] };

    // Determine discount % based on group's total packages
    const { discountPct: groupDiscountPct, tierLabel } =
      group.totalPackages > 0 && category.tiers.length > 0
        ? matchTier(group.totalPackages, category)
        : {
            discountPct: 0,
            tierLabel: category.tiers.length === 0 ? "No discount" : "Qty is 0",
          };

    console.log(`[DISCOUNT]   "${group.categoryName}": ${group.totalPackages} pkgs → ${groupDiscountPct}% (${tierLabel})`);

    // Apply this discount to all items in the group
    let groupTotalDiscount = 0;
    for (const lineIdx of group.lineIndices) {
      const item = lineData[lineIdx];
      const discountAmount = (item.lineAmount * groupDiscountPct) / 100;
      groupTotalDiscount += discountAmount;

      lines.push({
        itemName: item.itemName,
        qtyBase: item.qtyBase,
        unitsPerPkg: item.unitsPerPkg,
        packages: item.packages,
        lineAmount: item.lineAmount,
        categoryId: group.categoryId,
        categoryName: group.categoryName,
        discountPct: groupDiscountPct,
        discountAmount,
        tierLabel,
      });
    }

    // Record group summary with base tier info
    const summaryObj: GroupDiscountSummary = {
      categoryId: group.categoryId,
      categoryName: group.categoryName,
      totalPackages: group.totalPackages,
      appliedDiscountPct: groupDiscountPct,
      totalAmount: group.totalAmount,
      totalDiscount: groupTotalDiscount,
      baseTierInfo: tierLabel,
    };
    groupSummaries.push(summaryObj);
  }

  console.log(`[DISCOUNT] Phase 2 Complete. Lines created: ${lines.length}`);

  // ─── Phase 3: Apply Group Rules (upgrade discounts for combined categories) ───

  console.log(`[DISCOUNT RULE] Phase 3 Starting. Groups present:`, Array.from(groupMap.keys()));

  // Check each group rule
  for (const rule of DEFAULT_GROUP_RULES) {
    // Sum packages across all categories in this rule
    const ruleCategories = Array.from(groupMap.values()).filter((g) =>
      rule.categoryIds.includes(g.categoryId)
    );

    console.log(`[DISCOUNT RULE] Evaluating "${rule.name}":`, {
      requiredCategories: rule.categoryIds,
      foundCategories: ruleCategories.map((g) => ({ name: g.categoryName, pkgs: g.totalPackages })),
      totalPkgs: ruleCategories.reduce((s, g) => s + g.totalPackages, 0),
      threshold: rule.minPackages,
    });

    const rulePackages = ruleCategories.reduce((sum, g) => sum + g.totalPackages, 0);

    // If combined packages meet the threshold, upgrade discount
    if (rulePackages >= rule.minPackages) {
      console.log(`[DISCOUNT RULE] ✓ "${rule.name}" triggered! (${rulePackages} >= ${rule.minPackages}) → Applying ${rule.upgradeDiscountPct}%`);

      // Update all lines and group summaries for these categories
      for (let i = 0; i < lines.length; i++) {
        if (rule.categoryIds.includes(lines[i].categoryId)) {
          const oldPct = lines[i].discountPct;
          const oldAmount = lines[i].discountAmount;
          lines[i].discountPct = rule.upgradeDiscountPct;
          lines[i].discountAmount = (lines[i].lineAmount * lines[i].discountPct) / 100;
          lines[i].tierLabel = `${rule.name} → ${rule.upgradeDiscountPct}%`;
          console.log(`[DISCOUNT RULE]   Item "${lines[i].itemName}": ${oldPct}% (₹${oldAmount.toFixed(2)}) → ${lines[i].discountPct}% (₹${lines[i].discountAmount.toFixed(2)})`);
        }
      }

      // Update group summaries
      for (const summary of groupSummaries) {
        if (rule.categoryIds.includes(summary.categoryId)) {
          const oldDiscount = summary.appliedDiscountPct;
          const oldAmount = summary.totalDiscount;
          summary.appliedDiscountPct = rule.upgradeDiscountPct;
          summary.totalDiscount = (summary.totalAmount * summary.appliedDiscountPct) / 100;
          summary.groupRuleApplied = rule.name;
          console.log(`[DISCOUNT RULE]   Group "${summary.categoryName}": ${oldDiscount}% (₹${oldAmount.toFixed(2)}) → ${summary.appliedDiscountPct}% (₹${summary.totalDiscount.toFixed(2)})`);
        }
      }
    } else {
      console.log(`[DISCOUNT RULE] ✗ "${rule.name}" NOT triggered (${rulePackages} < ${rule.minPackages})`);
    }
  }

  const totalLineAmount = lineData.reduce((s, l) => s + l.lineAmount, 0);
  const totalDiscountAmount = lines.reduce((s, l) => s + l.discountAmount, 0);
  const effectivePct = totalLineAmount > 0 ? (totalDiscountAmount / totalLineAmount) * 100 : 0;

  console.log(`[DISCOUNT] ═══════════════════════════════════════════════════════════`);
  console.log(`[DISCOUNT] Final Result:`, {
    totalSubtotal: totalLineAmount,
    totalDiscount: totalDiscountAmount,
    effectiveRate: `${effectivePct.toFixed(2)}%`,
    rulesApplied: groupSummaries.filter((g) => g.groupRuleApplied).map((g) => g.groupRuleApplied),
  });
  console.log(`[DISCOUNT] ═══════════════════════════════════════════════════════════`);

  return { lines, groupSummaries, totalLineAmount, totalDiscountAmount, effectivePct };
}
