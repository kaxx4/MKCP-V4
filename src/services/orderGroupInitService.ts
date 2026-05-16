/**
 * Service to initialize order groups from vendor groups on app startup
 * Creates 16 order groups (one per vendor group) and assigns items to them
 */

import { useOrderGroupStore } from '../store/orderGroupStore';
import { useVendorGroupStore } from '../store/vendorGroupStore';
import { getAllVendorGroups } from '../data/vendorGroups';
import type { CanonicalItem } from '../types/canonical';

// Color mapping for order groups (matches vendor groups theme)
const VENDOR_GROUP_COLORS: Record<string, string> = {
  'kw-engineering': '#3b82f6',      // Blue
  'kw-gears': '#06b6d4',             // Cyan
  'bicycle-denvok': '#10b981',       // Green
  'bicycle-daman': '#84cc16',        // Lime
  'bicycle-amrit': '#f59e0b',        // Amber
  'spoke': '#f97316',                // Orange
  'locks': '#ef4444',                // Red
  'dewan-rubber': '#ec4899',         // Pink
  'birdi': '#8b5cf6',                // Purple
  'basket': '#6366f1',               // Indigo
  'bhogal': '#a855f7',               // Violet
  'veer-wheels': '#d946ef',          // Fuchsia
  'wasan-engineering': '#0891b2',    // Cyan-dark
  'sunshine-auto': '#ea580c',        // Orange-dark
  'tricycle-dash': '#7c3aed',        // Violet-dark
  'tricycle-karni': '#db2777',       // Rose
  'togo-default': '#64748b',         // Slate
};

/**
 * Initialize order groups from vendor groups
 * Creates one order group per vendor group and assigns items
 * Safe to call multiple times - only creates if groups don't exist
 */
export function initializeOrderGroups(items: CanonicalItem[] | undefined): void {
  if (!items || items.length === 0) {
    console.log('[OrderGroups] No items to organize');
    return;
  }

  const orderGroupStore = useOrderGroupStore.getState();
  const vendorGroupStore = useVendorGroupStore.getState();

  // Check if already initialized
  const existingGroups = orderGroupStore.getAllGroups();
  if (existingGroups.length > 0) {
    console.log(`[OrderGroups] Already initialized with ${existingGroups.length} groups`);
    return;
  }

  // Get vendor groups
  const vendorGroups = getAllVendorGroups();
  const vendorGroupAssignments = vendorGroupStore.assignments;

  // Create order group for each vendor group
  const groupIds: Record<string, string> = {};

  vendorGroups.forEach((vendorGroup) => {
    const groupId = orderGroupStore.createGroup(
      vendorGroup.name,
      vendorGroup.description,
      VENDOR_GROUP_COLORS[vendorGroup.id],
      [vendorGroup.id] // Tag with vendor group ID
    );
    groupIds[vendorGroup.id] = groupId;
  });

  // Assign items to order groups
  items.forEach((item) => {
    const vendorGroupId = vendorGroupAssignments[item.itemId];
    if (vendorGroupId && groupIds[vendorGroupId]) {
      const orderGroupId = groupIds[vendorGroupId];
      orderGroupStore.assignItemToGroup(orderGroupId, item.itemId);
    }
  });

  // Log summary
  const allGroups = orderGroupStore.getAllGroups();
  const groupsWithItems = allGroups.filter((g) => (g.itemIds?.length ?? 0) > 0);

  console.log(`[OrderGroups] ✓ Created ${allGroups.length} order groups`);
  groupsWithItems.forEach((group) => {
    console.log(`  - ${group.name}: ${group.itemIds?.length ?? 0} items`);
  });
}

/**
 * Reinitialize order groups (clear and recreate)
 */
export function reinitializeOrderGroups(items: CanonicalItem[] | undefined): void {
  if (!items || items.length === 0) {
    console.log('[OrderGroups] No items to organize');
    return;
  }

  const orderGroupStore = useOrderGroupStore.getState();

  // Delete all existing groups
  const allGroups = orderGroupStore.getAllGroups();
  allGroups.forEach((group) => {
    orderGroupStore.deleteGroup(group.id);
  });

  // Reinitialize
  initializeOrderGroups(items);
}

/**
 * Check if order groups are initialized
 */
export function isOrderGroupsInitialized(): boolean {
  const store = useOrderGroupStore.getState();
  return store.getAllGroups().length > 0;
}

/**
 * Get order groups initialization status
 */
export function getOrderGroupsStatus(): {
  initialized: boolean;
  groupCount: number;
  totalItems: number;
  groupsWithItems: number;
} {
  const store = useOrderGroupStore.getState();
  const allGroups = store.getAllGroups();
  const groupsWithItems = allGroups.filter((g) => (g.itemIds?.length ?? 0) > 0);

  let totalItems = 0;
  allGroups.forEach((group) => {
    totalItems += group.itemIds?.length ?? 0;
  });

  return {
    initialized: allGroups.length > 0,
    groupCount: allGroups.length,
    totalItems,
    groupsWithItems: groupsWithItems.length,
  };
}
