import { useEffect, useRef } from 'react';
import { useDiscountStore } from '../store/discountStore';
import { useOrderGroupStore } from '../store/orderGroupStore';
import { useOverrideStore } from '../store/overrideStore';
import { useVendorGroupStore } from '../store/vendorGroupStore';
import { useNotesStore } from '../store/notesStore';
import { useCallingListStore } from '../store/callingListStore';
import { useTallyPriceListStore } from '../store/tallyPriceListStore';

/**
 * Hook to sync ALL local configuration data to Supabase whenever stores change.
 * Debounced to avoid excessive API calls. Sync is best-effort — silent failures.
 *
 * Syncs the following:
 *  • Discount rules (categories)
 *  • Item -> category overrides
 *  • Category colors
 *  • Order groups
 *  • Unit overrides (alt units for items)
 *  • Rate overrides (custom rates)
 *  • Vendor group assignments
 *  • Item notes
 *  • Calling list entries
 *  • Tally price list imports
 */
export function useSupabaseConfigSync(company: string = 'M.K.CYCLES (P) LTD.') {
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Subscribe to all relevant stores
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

    // Debounce sync by 2 seconds to avoid hammering the server
    debounceTimerRef.current = setTimeout(async () => {
      try {
        // Convert discount categories to API format
        const discountRulesArray = Object.entries(discountRules).map(([key, category]: [string, any]) => ({
          id: key,
          name: category.name || key,
          category: key,
          discountType: category.type || 'percentage',
          discountValue: category.value || 0,
          conditions: category.conditions || {},
          priority: category.priority || 0,
          enabled: category.enabled !== false,
        }));

        const orderGroupsArray = Object.values(orderGroups);

        const rateOverridesArray = Object.entries(rateOverrides || {}).map(([itemId, rate]: [string, any]) => ({
          itemId,
          unitRate: rate.unitRate,
          pkgRate: rate.pkgRate,
          updatedAt: rate.updatedAt,
        }));

        const response = await fetch('http://localhost:3100/api/supabase/sync-config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
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
          }),
        });

        if (!response.ok) {
          const err = await response.text();
          console.warn(`[Config Sync] Warning: ${err}`);
          return;
        }

        const result = await response.json();
        console.log(`[Config Sync] ✓ Synced to Supabase:`, {
          discountRules: result.discountRulesCount,
          orderGroups: result.orderGroupsCount,
          unitOverrides: result.unitOverridesCount,
          rateOverrides: result.rateOverridesCount,
          itemCategoryOverrides: result.itemCategoryOverridesCount,
          categoryColors: result.categoryColorsCount,
          vendorGroupAssignments: result.vendorGroupAssignmentsCount,
          itemNotes: result.itemNotesCount,
          callingList: result.callingListCount,
          tallyPriceListImports: result.tallyPriceListImportsCount,
        });
      } catch (err: any) {
        // Silently log warnings - config sync is best-effort
        console.warn(`[Config Sync] Failed: ${err.message}`);
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
}
