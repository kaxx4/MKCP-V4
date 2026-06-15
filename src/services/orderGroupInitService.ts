/**
 * Service to initialize order groups on app startup.
 *
 * On first run (or after a full reset), seeds order groups from
 * `src/data/defaultOrderGroups.json` — 19 groups with their itemIds,
 * originally exported from the dashboard's Order Groups → Export on 2026-05-23.
 *
 * Once any groups exist, this is a no-op. The user retains full CRUD
 * (create / rename / delete / add items / remove items) via the Orders page
 * and the Import / Export JSON flow.
 *
 * To change defaults: re-export from the UI and overwrite the JSON.
 */

import { useOrderGroupStore } from '../store/orderGroupStore';
import { useVendorGroupStore } from '../store/vendorGroupStore';
import { getAllVendorGroups } from '../data/vendorGroups';
import type { CanonicalItem } from '../types/canonical';
import defaultOrderGroupsJson from '../data/defaultOrderGroups.json';

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

  // Build a set of imported itemIds so we only assign items that actually exist
  // in the current Tally dataset (avoids cluttering groups with stale names).
  const knownItemIds = new Set(items.map((i) => i.itemId));

  // Seed from defaultOrderGroups.json. Each group entry has a stable
  // grp_default_* id, name, description, color, tags, and a list of itemIds.
  // We use createGroup so the store generates a fresh runtime id; the JSON's
  // `id` field is just for traceability in the source file.
  for (const seed of defaultOrderGroupsJson.groups) {
    const groupId = orderGroupStore.createGroup(
      seed.name,
      seed.description,
      seed.color,
      seed.tags ?? []
    );
    for (const itemId of seed.itemIds ?? []) {
      // Skip items that don't exist in current Tally dataset (defensive)
      if (knownItemIds.has(itemId)) {
        orderGroupStore.assignItemToGroup(groupId, itemId);
      }
    }
  }

  // Log summary
  const allGroups = orderGroupStore.getAllGroups();
  const groupsWithItems = allGroups.filter((g) => (g.itemIds?.length ?? 0) > 0);

  console.log(`[OrderGroups] ✓ Seeded ${allGroups.length} default order groups`);
  groupsWithItems.forEach((group) => {
    console.log(`  - ${group.name}: ${group.itemIds?.length ?? 0} items`);
  });

  // Silence unused-warning for legacy color map + vendor groups
  void VENDOR_GROUP_COLORS;
  void getAllVendorGroups;
  void vendorGroupStore;
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
