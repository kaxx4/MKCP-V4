import {
  categorizeItemToGroup,
  getAllVendorGroups,
  getVendorGroupById,
  getVendorGroupName,
} from '../data/vendorGroups';
import { VENDOR_GROUP_ITEM_MAPPING } from '../data/vendorGroupMapping';
import type { CanonicalItem } from '../types/canonical';

/**
 * Service for managing vendor groups and item classifications
 */

/**
 * Auto-assign all items to their vendor groups based on naming patterns
 * Returns a mapping of itemId -> vendorGroupId
 */
export function autoAssignItemsToVendorGroups(
  items: CanonicalItem[]
): Record<string, string> {
  const assignments: Record<string, string> = {};

  items.forEach((item) => {
    assignments[item.itemId] = categorizeItemToGroup(item.name);
  });

  return assignments;
}

/**
 * Get items for a specific vendor group from canonical items
 */
export function getItemsForVendorGroup(
  items: CanonicalItem[],
  groupId: string,
  assignments: Record<string, string>
): CanonicalItem[] {
  return items.filter((item) => assignments[item.itemId] === groupId);
}

/**
 * Generate a vendor group summary with item counts
 */
export function generateVendorGroupSummary(
  items: CanonicalItem[],
  assignments: Record<string, string>
) {
  const allGroups = getAllVendorGroups();

  return allGroups.map((group) => {
    const itemCount = items.filter(
      (item) => assignments[item.itemId] === group.id
    ).length;

    return {
      id: group.id,
      name: group.name,
      description: group.description,
      itemCount,
      percentage: items.length > 0 ? ((itemCount / items.length) * 100).toFixed(1) : '0',
    };
  });
}

/**
 * Export vendor groups as a CSV report
 */
export function exportVendorGroupsAsCSV(
  items: CanonicalItem[],
  assignments: Record<string, string>
): string {
  const allGroups = getAllVendorGroups();
  let csv = 'Item Name,Item ID,Vendor Group\n';

  items.forEach((item) => {
    const groupId = assignments[item.itemId];
    const groupName = getVendorGroupName(groupId);
    const safeName = `"${item.name.replace(/"/g, '""')}"`;
    csv += `${safeName},${item.itemId},${groupName}\n`;
  });

  return csv;
}

/**
 * Validate vendor group assignments (check for any items without assignments)
 */
export function validateVendorGroupAssignments(
  items: CanonicalItem[],
  assignments: Record<string, string>
): {
  isValid: boolean;
  unassignedItems: CanonicalItem[];
  duplicateAssignments: string[];
} {
  const unassignedItems = items.filter((item) => !assignments[item.itemId]);

  // Check for duplicate assignments (shouldn't happen in our case)
  const assignedIds = Object.keys(assignments);
  const itemIds = items.map((i) => i.itemId);
  const duplicateAssignments = assignedIds.filter(
    (id) => itemIds.filter((itemId) => itemId === id).length > 1
  );

  return {
    isValid: unassignedItems.length === 0 && duplicateAssignments.length === 0,
    unassignedItems,
    duplicateAssignments,
  };
}

/**
 * Get detailed statistics about vendor groups
 */
export function getVendorGroupStatistics(
  items: CanonicalItem[],
  assignments: Record<string, string>
) {
  const summary = generateVendorGroupSummary(items, assignments);

  const stats = {
    totalItems: items.length,
    totalGroups: summary.length,
    groupsWithItems: summary.filter((g) => g.itemCount > 0).length,
    groupsWithoutItems: summary.filter((g) => g.itemCount === 0).length,
    largestGroup: summary.reduce((a, b) =>
      (a.itemCount || 0) > (b.itemCount || 0) ? a : b
    ),
    smallestGroupWithItems: summary
      .filter((g) => g.itemCount > 0)
      .reduce((a, b) =>
        (a.itemCount || 0) < (b.itemCount || 0) ? a : b,
        summary[0]
      ),
    summary,
  };

  return stats;
}

/**
 * Batch reassign items from one group to another
 */
export function batchReassignItems(
  itemIds: string[],
  targetGroupId: string,
  currentAssignments: Record<string, string>
): Record<string, string> {
  const updated = { ...currentAssignments };

  itemIds.forEach((itemId) => {
    updated[itemId] = targetGroupId;
  });

  return updated;
}

/**
 * Reset assignments for specific items back to auto-categorization
 */
export function resetItemAssignments(
  items: CanonicalItem[],
  itemIds: string[],
  currentAssignments: Record<string, string>
): Record<string, string> {
  const updated = { ...currentAssignments };
  const itemMap = new Map(items.map((i) => [i.itemId, i]));

  itemIds.forEach((itemId) => {
    const item = itemMap.get(itemId);
    if (item) {
      updated[itemId] = categorizeItemToGroup(item.name);
    }
  });

  return updated;
}
