import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { OrderLine } from "./orderStore";

export interface OrderGroup {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  lines: Record<string, OrderLine>;
  tags: string[];
  color: string;
}

interface OrderGroupState {
  groups: Record<string, OrderGroup>;
  activeGroupId: string | null;

  createGroup: (name: string, description?: string, color?: string, tags?: string[]) => string;
  updateGroup: (id: string, updates: Partial<Pick<OrderGroup, "name" | "description" | "color" | "tags">>) => void;
  deleteGroup: (id: string) => void;
  duplicateGroup: (id: string) => string | null;
  setActiveGroup: (id: string | null) => void;

  setGroupLines: (groupId: string, lines: Record<string, OrderLine>) => void;
  addLinesToGroup: (groupId: string, lines: Record<string, OrderLine>) => void;
  removeLineFromGroup: (groupId: string, itemId: string) => void;
  clearGroupLines: (groupId: string) => void;

  getGroup: (id: string) => OrderGroup | null;
  getAllGroups: () => OrderGroup[];
  getGroupLineCount: (id: string) => number;
  getGroupTotalValue: (id: string) => number;
  exportGroupAsLines: (id: string) => OrderLine[];
}

const COLORS = [
  "#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6",
  "#ec4899", "#06b6d4", "#84cc16", "#f97316", "#6366f1",
];

function generateId(): string {
  return `grp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

export const useOrderGroupStore = create<OrderGroupState>()(
  persist(
    (set, get) => ({
      groups: {},
      activeGroupId: null,

      createGroup: (name, description = "", color, tags = []) => {
        const id = generateId();
        const groupCount = Object.keys(get().groups).length;
        const assignedColor = color || COLORS[groupCount % COLORS.length];
        const group: OrderGroup = {
          id,
          name,
          description,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          lines: {},
          tags,
          color: assignedColor,
        };
        set((s) => ({ groups: { ...s.groups, [id]: group } }));
        return id;
      },

      updateGroup: (id, updates) => {
        set((s) => {
          const group = s.groups[id];
          if (!group) return s;
          return {
            groups: {
              ...s.groups,
              [id]: { ...group, ...updates, updatedAt: new Date().toISOString() },
            },
          };
        });
      },

      deleteGroup: (id) => {
        set((s) => {
          const { [id]: _, ...rest } = s.groups;
          return {
            groups: rest,
            activeGroupId: s.activeGroupId === id ? null : s.activeGroupId,
          };
        });
      },

      duplicateGroup: (id) => {
        const source = get().groups[id];
        if (!source) return null;
        const newId = generateId();
        const newGroup: OrderGroup = {
          ...source,
          id: newId,
          name: `${source.name} (copy)`,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          lines: { ...source.lines },
        };
        set((s) => ({ groups: { ...s.groups, [newId]: newGroup } }));
        return newId;
      },

      setActiveGroup: (activeGroupId) => set({ activeGroupId }),

      setGroupLines: (groupId, lines) => {
        set((s) => {
          const group = s.groups[groupId];
          if (!group) return s;
          return {
            groups: {
              ...s.groups,
              [groupId]: { ...group, lines, updatedAt: new Date().toISOString() },
            },
          };
        });
      },

      addLinesToGroup: (groupId, lines) => {
        set((s) => {
          const group = s.groups[groupId];
          if (!group) return s;
          return {
            groups: {
              ...s.groups,
              [groupId]: {
                ...group,
                lines: { ...group.lines, ...lines },
                updatedAt: new Date().toISOString(),
              },
            },
          };
        });
      },

      removeLineFromGroup: (groupId, itemId) => {
        set((s) => {
          const group = s.groups[groupId];
          if (!group) return s;
          const { [itemId]: _, ...rest } = group.lines;
          return {
            groups: {
              ...s.groups,
              [groupId]: { ...group, lines: rest, updatedAt: new Date().toISOString() },
            },
          };
        });
      },

      clearGroupLines: (groupId) => {
        set((s) => {
          const group = s.groups[groupId];
          if (!group) return s;
          return {
            groups: {
              ...s.groups,
              [groupId]: { ...group, lines: {}, updatedAt: new Date().toISOString() },
            },
          };
        });
      },

      getGroup: (id) => get().groups[id] ?? null,
      getAllGroups: () => Object.values(get().groups).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      getGroupLineCount: (id) => Object.keys(get().groups[id]?.lines ?? {}).length,
      getGroupTotalValue: (id) => {
        const group = get().groups[id];
        if (!group) return 0;
        return Object.values(group.lines).reduce((sum, l) => sum + l.qtyBase * l.ratePerBase, 0);
      },
      exportGroupAsLines: (id) => {
        const group = get().groups[id];
        if (!group) return [];
        return Object.values(group.lines);
      },
    }),
    { name: "mkcycles-order-groups" }
  )
);
