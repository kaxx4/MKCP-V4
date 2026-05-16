import { useMemo } from 'react';
import { useVendorGroupStore } from '../store/vendorGroupStore';
import { getAllVendorGroups, getVendorGroupById } from '../data/vendorGroups';
import {
  autoAssignItemsToVendorGroups,
  getItemsForVendorGroup,
  generateVendorGroupSummary,
  getVendorGroupStatistics,
} from '../services/vendorGroupService';
import type { CanonicalItem } from '../types/canonical';

/**
 * Hook for working with vendor groups
 * Provides memoized calculations and easy access to vendor group data
 */
export function useVendorGroups(items: CanonicalItem[]) {
  const {
    assignments,
    autoAssignItems,
    assignItem,
    getItemGroup,
    getItemsInGroup,
    getGroupsSummary,
  } = useVendorGroupStore();

  // Get all vendor groups
  const allGroups = useMemo(() => getAllVendorGroups(), []);

  // Generate summary with current assignments
  const summary = useMemo(
    () => generateVendorGroupSummary(items, assignments),
    [items, assignments]
  );

  // Get statistics
  const stats = useMemo(
    () => getVendorGroupStatistics(items, assignments),
    [items, assignments]
  );

  // Get items for a specific group
  const getGroupItems = useMemo(
    () => (groupId: string) => getItemsForVendorGroup(items, groupId, assignments),
    [items, assignments]
  );

  // Filter items by group
  const filterByGroup = useMemo(
    () => (groupId: string) => {
      if (groupId === 'ALL') return items;
      return items.filter((item) => assignments[item.itemId] === groupId);
    },
    [items, assignments]
  );

  // Get group details
  const getGroupDetail = (groupId: string) => {
    const group = getVendorGroupById(groupId);
    const itemCount = items.filter(
      (item) => assignments[item.itemId] === groupId
    ).length;

    return {
      ...group,
      itemCount,
      percentage: items.length > 0 ? ((itemCount / items.length) * 100).toFixed(1) : '0',
    };
  };

  return {
    // Data
    allGroups,
    assignments,
    summary,
    stats,

    // Actions
    autoAssignItems,
    assignItem,

    // Getters
    getItemGroup,
    getItemsInGroup,
    getGroupsSummary,
    getGroupItems,
    getGroupDetail,

    // Filters
    filterByGroup,
  };
}

/**
 * Hook to initialize vendor groups from items (call once on app start)
 */
export function useInitializeVendorGroups(items: CanonicalItem[]) {
  const { autoAssignItems, assignments } = useVendorGroupStore();

  // Auto-assign on first load
  const needsInitialization = Object.keys(assignments).length === 0;

  if (needsInitialization && items.length > 0) {
    autoAssignItems(items);
  }
}

/**
 * Hook to filter items by vendor group
 * @param items - All items
 * @param selectedGroupId - Group ID to filter by ('ALL' shows all)
 * @returns Filtered items
 */
export function useVendorGroupFilter(
  items: CanonicalItem[],
  selectedGroupId: string
) {
  const { assignments } = useVendorGroupStore();

  const filteredItems = useMemo(() => {
    if (selectedGroupId === 'ALL') {
      return items;
    }

    return items.filter((item) => assignments[item.itemId] === selectedGroupId);
  }, [items, selectedGroupId, assignments]);

  return filteredItems;
}

/**
 * Hook to get vendor group options for select/dropdown
 */
export function useVendorGroupOptions() {
  const groups = useMemo(() => {
    return [
      { value: 'ALL', label: 'All Groups' },
      ...getAllVendorGroups().map((g) => ({
        value: g.id,
        label: g.name,
      })),
    ];
  }, []);

  return groups;
}
