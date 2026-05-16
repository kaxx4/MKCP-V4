import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  VENDOR_GROUPS,
  DEFAULT_GROUP,
  categorizeItemToGroup,
  getAllVendorGroups,
} from '../data/vendorGroups';

export interface VendorGroupAssignment {
  [itemId: string]: string; // itemId -> vendorGroupId
}

interface VendorGroupStore {
  assignments: VendorGroupAssignment;

  // Assign an item to a vendor group
  assignItem: (itemId: string, groupId: string) => void;

  // Get the vendor group for an item
  getItemGroup: (itemId: string) => string;

  // Auto-assign items based on naming patterns
  autoAssignItems: (items: Array<{ itemId: string; name: string }>) => void;

  // Get all items in a vendor group
  getItemsInGroup: (groupId: string) => string[];

  // Get vendor groups summary (with item counts)
  getGroupsSummary: () => Array<{
    id: string;
    name: string;
    description: string;
    itemCount: number;
  }>;

  // Reset all assignments
  resetAssignments: () => void;

  // Batch assign items
  batchAssignItems: (assignments: VendorGroupAssignment) => void;
}

export const useVendorGroupStore = create<VendorGroupStore>()(
  persist(
    (set, get) => ({
      assignments: {},

      assignItem: (itemId: string, groupId: string) => {
        set((state) => ({
          assignments: {
            ...state.assignments,
            [itemId]: groupId,
          },
        }));
      },

      getItemGroup: (itemId: string) => {
        return get().assignments[itemId] || DEFAULT_GROUP.id;
      },

      autoAssignItems: (items: Array<{ itemId: string; name: string }>) => {
        const newAssignments: VendorGroupAssignment = {};
        items.forEach(({ itemId, name }) => {
          newAssignments[itemId] = categorizeItemToGroup(name);
        });
        set(() => ({
          assignments: newAssignments,
        }));
      },

      getItemsInGroup: (groupId: string) => {
        const assignments = get().assignments;
        return Object.entries(assignments)
          .filter(([, assignedGroupId]) => assignedGroupId === groupId)
          .map(([itemId]) => itemId);
      },

      getGroupsSummary: () => {
        const assignments = get().assignments;
        const allGroups = getAllVendorGroups();

        return allGroups.map((group) => {
          const itemCount = Object.values(assignments).filter(
            (groupId) => groupId === group.id
          ).length;

          return {
            id: group.id,
            name: group.name,
            description: group.description,
            itemCount,
          };
        });
      },

      resetAssignments: () => {
        set(() => ({
          assignments: {},
        }));
      },

      batchAssignItems: (assignments: VendorGroupAssignment) => {
        set((state) => ({
          assignments: {
            ...state.assignments,
            ...assignments,
          },
        }));
      },
    }),
    {
      name: 'vendor-group-store',
      version: 1,
    }
  )
);
