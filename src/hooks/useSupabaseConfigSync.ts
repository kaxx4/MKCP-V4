// NOTE: kept at this path because pushAll imports syncConfigToSupabase from here.
// The old useSupabaseConfigSync hook (2s-debounce auto-push on config edits) was
// removed — the scheduled quick syncs push config via pushAll, so it was redundant.
import { useDiscountStore } from '../store/discountStore';
import { useOrderGroupStore } from '../store/orderGroupStore';
import { useOverrideStore } from '../store/overrideStore';
import { useVendorGroupStore } from '../store/vendorGroupStore';
import { useNotesStore } from '../store/notesStore';
import { useCallingListStore } from '../store/callingListStore';
import { useTallyPriceListStore } from '../store/tallyPriceListStore';
import { useCalendarStore } from '../store/calendarStore';
import { useUIStore } from '../store/uiStore';
import { useTallyStore } from '../store/tallyStore';
import { useOrderStore } from '../store/orderStore';
import { useSupabaseSyncStatusStore } from '../store/supabaseSyncStatusStore';

const DEFAULT_COMPANY = 'M.K.CYCLES (P) LTD.';
const SERVER_URL = 'http://localhost:3100/api/supabase/sync-config';

export interface SyncResult {
  success: boolean;
  counts: {
    discountRules: number;
    orderGroups: number;
    unitOverrides: number;
    rateOverrides: number;
    gstOverrides: number;
    itemCategoryOverrides: number;
    categoryColors: number;
    vendorGroupAssignments: number;
    itemNotes: number;
    callingList: number;
    tallyPriceListImports: number;
    voucherOverrides: number;
    appSettings: number;
    orderDraftLines: number;
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
  const gstOverrides = useOverrideStore.getState().gstRates;
  const vendorGroupAssignments = useVendorGroupStore.getState().assignments;
  const itemNotes = useNotesStore.getState().notes;
  const callingList = useCallingListStore.getState().entries;
  const tallyPriceList = useTallyPriceListStore.getState().entries;
  const tallyPriceListImportedAt = useTallyPriceListStore.getState().importedAt;
  const voucherOverrides = useCalendarStore.getState().overrides;

  // User preferences (uiStore) + Tally connection config (tallyStore).
  // Flattened into a single app_settings key/value bag so the schema doesn't
  // need to change every time a new pref is added.
  const ui = useUIStore.getState();
  const tally = useTallyStore.getState();
  const appSettings: Record<string, any> = {
    unitMode: ui.unitMode,
    fyYear: ui.fyYear,
    coverMonths: ui.coverMonths,
    leadTimeMonths: ui.leadTimeMonths,
    defaultCreditDays: ui.defaultCreditDays,
    sidebarOpen: ui.sidebarOpen,
    tallyProxyUrl: tally.proxyUrl,
    tallyCompanyName: tally.companyName,
    tallyAutoSyncMinutes: tally.autoSyncMinutes,
    tallyFyFromDate: tally.fyFromDate,
    tallyFyToDate: tally.fyToDate,
    tallySyncMode: tally.syncMode,
    tallyLastSyncAt: tally.lastSyncAt,
    tallyLastMastersSyncAt: tally.lastMastersSyncAt,
    tallyLastVouchersSyncAt: tally.lastVouchersSyncAt,
    tallyLastVoucherDate: tally.lastVoucherDate,
  };

  // Current order draft (orderStore.lines) — user-typed quantities not yet
  // saved as a named order group. Replace strategy on the cloud side.
  const orderDraftLines = Object.values(useOrderStore.getState().lines);

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
    gstOverrides: gstOverrides || {},
    itemCategoryOverrides: itemCategoryOverrides || {},
    categoryColors: categoryColors || {},
    vendorGroupAssignments: vendorGroupAssignments || {},
    itemNotes: itemNotes || {},
    callingList: callingList || [],
    tallyPriceListImports: tallyPriceList || {},
    tallyPriceListImportedAt: tallyPriceListImportedAt,
    voucherOverrides: voucherOverrides || {},
    appSettings,
    orderDraftLines,
  };
}

/**
 * Force-push the full payload to Supabase immediately. Returns a SyncResult.
 * Used by the "Push to Supabase Now" button in Settings.
 */
export async function syncConfigToSupabase(company: string = DEFAULT_COMPANY): Promise<SyncResult> {
  const status = useSupabaseSyncStatusStore.getState();
  try {
    const payload = buildSyncPayload(company);
    const response = await fetch(SERVER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const err = await response.text();
      const errMsg = err || `HTTP ${response.status}`;
      status.recordResult('config', false, errMsg);
      return {
        success: false,
        counts: emptyCounts(),
        errors: [errMsg],
      };
    }

    const result = await response.json();
    // Per-table errors from /api/supabase/sync-config are surfaced in result.errors.
    // If any table failed, mark the channel as failed so the NavBar indicator + retry
    // schedule kick in.
    const hadPerTableErrors = Array.isArray(result.errors) && result.errors.length > 0;
    status.recordResult(
      'config',
      !hadPerTableErrors,
      hadPerTableErrors ? result.errors.join(' | ') : null,
    );
    return {
      success: true,
      counts: {
        discountRules: result.discountRulesCount || 0,
        orderGroups: result.orderGroupsCount || 0,
        unitOverrides: result.unitOverridesCount || 0,
        rateOverrides: result.rateOverridesCount || 0,
        gstOverrides: result.gstOverridesCount || 0,
        itemCategoryOverrides: result.itemCategoryOverridesCount || 0,
        categoryColors: result.categoryColorsCount || 0,
        vendorGroupAssignments: result.vendorGroupAssignmentsCount || 0,
        itemNotes: result.itemNotesCount || 0,
        callingList: result.callingListCount || 0,
        tallyPriceListImports: result.tallyPriceListImportsCount || 0,
        voucherOverrides: result.voucherOverridesCount || 0,
        appSettings: result.appSettingsCount || 0,
        orderDraftLines: result.orderDraftLinesCount || 0,
      },
      errors: result.errors,
      message: result.message,
    };
  } catch (err: any) {
    const errMsg = err?.message || String(err);
    status.recordResult('config', false, errMsg);
    return {
      success: false,
      counts: emptyCounts(),
      errors: [errMsg],
    };
  }
}

function emptyCounts() {
  return {
    discountRules: 0,
    orderGroups: 0,
    unitOverrides: 0,
    rateOverrides: 0,
    gstOverrides: 0,
    itemCategoryOverrides: 0,
    categoryColors: 0,
    vendorGroupAssignments: 0,
    itemNotes: 0,
    callingList: 0,
    tallyPriceListImports: 0,
    voucherOverrides: 0,
    appSettings: 0,
    orderDraftLines: 0,
  };
}
