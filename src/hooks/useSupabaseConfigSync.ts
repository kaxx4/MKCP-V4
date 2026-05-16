import { useEffect, useRef } from 'react';
import { useDiscountStore } from '../store/discountStore';
import { useOrderGroupStore } from '../store/orderGroupStore';
import { useOverrideStore } from '../store/overrideStore';

/**
 * Hook to sync local configuration data (discounts, order groups, unit overrides)
 * to Supabase whenever stores change. Debounced to avoid excessive API calls.
 */
export function useSupabaseConfigSync(company: string = 'M.K.CYCLES (P) LTD.') {
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const discountRules = useDiscountStore((s) => s.categories);
  const orderGroups = useOrderGroupStore((s) => s.groups);
  const unitOverrides = useOverrideStore((s) => s.units);
  const rateOverrides = useOverrideStore((s) => s.rates);

  useEffect(() => {
    // Clear existing timer
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    // Debounce sync by 2 seconds to avoid hammering the server
    debounceTimerRef.current = setTimeout(async () => {
      try {
        // Convert store formats to API format
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

        const unitOverridesObj = unitOverrides || {};
        const rateOverridesArray = Object.entries(rateOverrides || {}).map(([itemId, rate]: [string, any]) => ({
          itemId,
          unitRate: rate.unitRate,
          pkgRate: rate.pkgRate,
          updatedAt: rate.updatedAt,
        }));

        // Call server API to sync config
        const response = await fetch('http://localhost:3100/api/supabase/sync-config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            company,
            discountRules: discountRulesArray,
            orderGroups: orderGroupsArray,
            unitOverrides: unitOverridesObj,
            rateOverrides: rateOverridesArray,
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
  }, [discountRules, orderGroups, unitOverrides, rateOverrides, company]);
}
