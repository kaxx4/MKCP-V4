/**
 * Service to initialize vendor groups on app startup
 * Auto-assigns all items to their vendor groups based on naming patterns
 */

import { useVendorGroupStore } from '../store/vendorGroupStore';
import { categorizeItemToGroup } from '../data/vendorGroups';
import type { CanonicalItem } from '../types/canonical';

/**
 * Initialize vendor groups for all items
 * Safe to call multiple times - only assigns if store is empty
 */
export function initializeVendorGroups(items: CanonicalItem[] | undefined): void {
  if (!items || items.length === 0) {
    console.log('[VendorGroups] No items to categorize');
    return;
  }

  const store = useVendorGroupStore.getState();
  const currentAssignments = store.assignments;

  // Check if already initialized
  const hasExistingAssignments = Object.keys(currentAssignments).length > 0;

  if (hasExistingAssignments) {
    console.log(
      `[VendorGroups] Already initialized with ${Object.keys(currentAssignments).length} assignments`
    );
    return;
  }

  // Auto-assign all items
  const assignments: Record<string, string> = {};
  items.forEach((item) => {
    assignments[item.itemId] = categorizeItemToGroup(item.name);
  });

  store.batchAssignItems(assignments);

  // Log summary
  const summary = store.getGroupsSummary();
  const groupsWithItems = summary.filter((g) => g.itemCount > 0);

  console.log(
    `[VendorGroups] ✓ Initialized ${items.length} items into ${groupsWithItems.length} vendor groups`
  );

  groupsWithItems.forEach((group) => {
    console.log(`  - ${group.name}: ${group.itemCount} items`);
  });
}

/**
 * Re-initialize vendor groups (force refresh)
 * Use this if items change or you want to reset assignments
 */
export function reinitializeVendorGroups(items: CanonicalItem[] | undefined): void {
  if (!items || items.length === 0) {
    console.log('[VendorGroups] No items to categorize');
    return;
  }

  const store = useVendorGroupStore.getState();

  // Reset and reassign
  store.resetAssignments();

  const assignments: Record<string, string> = {};
  items.forEach((item) => {
    assignments[item.itemId] = categorizeItemToGroup(item.name);
  });

  store.batchAssignItems(assignments);

  console.log(`[VendorGroups] ✓ Re-initialized ${items.length} items`);
}

/**
 * Check if vendor groups are initialized
 */
export function isVendorGroupsInitialized(): boolean {
  const store = useVendorGroupStore.getState();
  return Object.keys(store.assignments).length > 0;
}

/**
 * Get vendor groups initialization status
 */
export function getVendorGroupsStatus(): {
  initialized: boolean;
  itemCount: number;
  groupCount: number;
} {
  const store = useVendorGroupStore.getState();
  const summary = store.getGroupsSummary();

  return {
    initialized: Object.keys(store.assignments).length > 0,
    itemCount: Object.keys(store.assignments).length,
    groupCount: summary.filter((g) => g.itemCount > 0).length,
  };
}
