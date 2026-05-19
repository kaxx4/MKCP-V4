import { useEffect, useRef, useCallback } from 'react';
import { useDiscountStore } from '../store/discountStore';
import { useOrderGroupStore } from '../store/orderGroupStore';
import { useOverrideStore } from '../store/overrideStore';
import { useVendorGroupStore } from '../store/vendorGroupStore';
import { useNotesStore } from '../store/notesStore';
import { useCallingListStore } from '../store/callingListStore';
import { useTallyPriceListStore } from '../store/tallyPriceListStore';

const DEFAULT_COMPANY = 'M.K.CYCLES (P) LTD.';
const SERVER_URL = 'http://localhost:3100/api/supabase/sync-config';

export interface SyncResult {
  success: boolean;
  counts: {
    discountRules: number;
    orderGroups: number;
    unitOverrides: number;
    rateOverrides: number;
    itemCategoryOverrides: number;
    categoryColors: number;
    vendorGroupAssignments: number;
    itemNotes: number;
    callingList: number;
    tallyPriceListImports: number;
  };
  errors?: string[];
  message?: string;
}

/**
 * Build the sync payload from current Zustand store state (single source of truth).
 * Used by both the auto-sync hook and the manual "Push Now" trigger.
 */
function buildSyncPayload(company: string = DEFAULT_COMPANY) {
  const discountRules = useDiscountStore.getState().categories;
  const itemCategoryOverrides = useDiscountStore.getState().itemCategoryOverrides;
  const categoryColors = useDiscountStore.getState().categoryColors;
  const orderGroups = useOrderGroupStore.getState().groups;
  const unitOverrides = useOverrideStore.getState().units;
  const rateOverrides = useOverrideStore.getState().rates;
  const vendorGroupAssignments = useVendorGroupStore.getState().assignments;
  const itemNotes = useNotesStore.getState().notes;
  const callingList = useCallingListStore.getState().entries;
  const tallyPriceList = useTallyPriceListStore.getState().entries;
  const tallyPriceListImportedAt = useTallyPriceListStore.getState().importedAt;

  // discountStore.categories is DiscountCategory[] = Array<{id, name, tiers}>
  // Map tiers to JSONB conditions field. Use category.id as both id and category.
  const discountRulesArray = (discountRules as any[]).map((category: any, idx: number) => ({
    id: category.id || `cat_${idx}`,
    name: category.name || category.id || `Category ${idx}`,
    category: category.id || `cat_${idx}`,
    discountType: 'tiered',
    discountValue: 0,
    conditions: { tiers: category.tiers || [] },
    priority: idx,
    enabled: true,
  }));

  const orderGroupsArray = Object.values(orderGroups);

  const rateOverridesArray = Object.entries(rateOverrides || {}).map(([itemId, rate]: [string, any]) => ({
    itemId,
    unitRate: rate.unitRate,
    pkgRate: rate.pkgRate,
    updatedAt: rate.updatedAt,
  }));

  return {
    company,
    discountRules: discountRulesArray,
    orderGroups: orderGroupsArray,
    unitOverrides: unitOverrides || {},
    rateOverrides: rateOverridesArray,
    itemCategoryOverrides: itemCategoryOverrides || {},
    categoryColors: categoryColors || {},
    vendorGroupAssignments: vendorGroupAssignments || {},
    itemNotes: itemNotes || {},
    callingList: callingList || [],
    tallyPriceListImports: tallyPriceList || {},
    tallyPriceListImportedAt: tallyPriceListImportedAt,
  };
}

/**
 * Force-push the full payload to Supabase immediately. Returns a SyncResult.
 * Used by the "Push to Supabase Now" button in Settings.
 */
export async function syncConfigToSupabase(company: string = DEFAULT_COMPANY): Promise<SyncResult> {
  try {
    const payload = buildSyncPayload(company);
    const response = await fetch(SERVER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const err = await response.text();
      return {
        success: false,
        counts: emptyCounts(),
        errors: [err || `HTTP ${response.status}`],
      };
    }

    const result = await response.json();
    return {
      success: true,
      counts: {
        discountRules: result.discountRulesCount || 0,
        orderGroups: result.orderGroupsCount || 0,
        unitOverrides: result.unitOverridesCount || 0,
        rateOverrides: result.rateOverridesCount || 0,
        itemCategoryOverrides: result.itemCategoryOverridesCount || 0,
        categoryColors: result.categoryColorsCount || 0,
        vendorGroupAssignments: result.vendorGroupAssignmentsCount || 0,
        itemNotes: result.itemNotesCount || 0,
        callingList: result.callingListCount || 0,
        tallyPriceListImports: result.tallyPriceListImportsCount || 0,
      },
      errors: result.errors,
      message: result.message,
    };
  } catch (err: any) {
    return {
      success: false,
      counts: emptyCounts(),
      errors: [err?.message || String(err)],
    };
  }
}

function emptyCounts() {
  return {
    discountRules: 0,
    orderGroups: 0,
    unitOverrides: 0,
    rateOverrides: 0,
    itemCategoryOverrides: 0,
    categoryColors: 0,
    vendorGroupAssignments: 0,
    itemNotes: 0,
    callingList: 0,
    tallyPriceListImports: 0,
  };
}

/**
 * Hook to auto-sync ALL local configuration data to Supabase whenever stores change.
 * Debounced 2s. Best-effort — failures logged to console, no UI noise.
 *
 * Syncs the following:
 *  • Discount rules (categories + tiers)
 *  • Item -> category overrides (item assignments)
 *  • Category colors
 *  • Order groups (with items/lines)
 *  • Unit overrides (alt units for items)
 *  • Rate overrides (custom rates / price list)
 *  • Vendor group assignments
 *  • Item notes
 *  • Calling list entries
 *  • Tally price list imports (uploaded JSON)
 */
export function useSupabaseConfigSync(company: string = DEFAULT_COMPANY) {
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Subscribe to all relevant stores so the effect re-fires on any change
  const discountRules = useDiscountStore((s) => s.categories);
  const itemCategoryOverrides = useDiscountStore((s) => s.itemCategoryOverrides);
  const categoryColors = useDiscountStore((s) => s.categoryColors);
  const orderGroups = useOrderGroupStore((s) => s.groups);
  const unitOverrides = useOverrideStore((s) => s.units);
  const rateOverrides = useOverrideStore((s) => s.rates);
  const vendorGroupAssignments = useVendorGroupStore((s) => s.assignments);
  const itemNotes = useNotesStore((s) => s.notes);
  const callingList = useCallingListStore((s) => s.entries);
  const tallyPriceList = useTallyPriceListStore((s) => s.entries);
  const tallyPriceListImportedAt = useTallyPriceListStore((s) => s.importedAt);

  useEffect(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    debounceTimerRef.current = setTimeout(async () => {
      const result = await syncConfigToSupabase(company);
      if (result.success) {
        console.log(`[Config Sync] ✓ Synced to Supabase:`, result.counts);
      } else {
        console.warn(`[Config Sync] Failed:`, result.errors);
      }
    }, 2000);

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [
    discountRules,
    itemCategoryOverrides,
    categoryColors,
    orderGroups,
    unitOverrides,
    rateOverrides,
    vendorGroupAssignments,
    itemNotes,
    callingList,
    tallyPriceList,
    tallyPriceListImportedAt,
    company,
  ]);

  // Expose manual trigger for "Push Now" buttons
  const pushNow = useCallback(async () => syncConfigToSupabase(company), [company]);
  return { pushNow };
}
