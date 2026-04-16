import { create } from "zustand";
import { persist } from "zustand/middleware";

// Local status overlaid on top of Tally vouchers
export type KanbanStatus =
  | "pending"
  | "confirmed"
  | "dispatched"
  | "delivered"
  | "invoiced"
  | "done";

export interface VoucherOverride {
  status: KanbanStatus;
  scheduledDate?: string; // YYYY-MM-DD — overrides the voucher's original date
  notes?: string;
  followUps: { date: string; action: string; notes?: string }[];
}

interface CalendarState {
  // Per-voucher local overrides (keyed by voucherId)
  overrides: Record<string, VoucherOverride>;

  // UI state
  viewType: "month" | "kanban" | "list";
  selectedId: string | null;
  currentMonth: string; // YYYY-MM-01

  // Which voucher types to show
  showTypes: string[]; // e.g. ["Delivery Note", "Sales"]

  // Actions
  setStatus: (voucherId: string, status: KanbanStatus) => void;
  setScheduledDate: (voucherId: string, date: string) => void;
  setNotes: (voucherId: string, notes: string) => void;
  addFollowUp: (voucherId: string, action: string, notes?: string) => void;
  resetOverride: (voucherId: string) => void;
  setViewType: (t: "month" | "kanban" | "list") => void;
  setSelectedId: (id: string | null) => void;
  setCurrentMonth: (m: string) => void;
  setShowTypes: (types: string[]) => void;
}

function firstOfMonth(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

function getOrCreate(
  overrides: Record<string, VoucherOverride>,
  id: string
): VoucherOverride {
  return (
    overrides[id] ?? { status: "pending", followUps: [] }
  );
}

export const useCalendarStore = create<CalendarState>()(
  persist(
    (set) => ({
      overrides: {},
      viewType: "month",
      selectedId: null,
      currentMonth: firstOfMonth(new Date()),
      showTypes: ["Delivery Note", "Sales"],

      setStatus: (id, status) =>
        set((s) => ({
          overrides: {
            ...s.overrides,
            [id]: { ...getOrCreate(s.overrides, id), status },
          },
        })),

      setScheduledDate: (id, date) =>
        set((s) => ({
          overrides: {
            ...s.overrides,
            [id]: { ...getOrCreate(s.overrides, id), scheduledDate: date },
          },
        })),

      setNotes: (id, notes) =>
        set((s) => ({
          overrides: {
            ...s.overrides,
            [id]: { ...getOrCreate(s.overrides, id), notes },
          },
        })),

      addFollowUp: (id, action, notes) =>
        set((s) => {
          const existing = getOrCreate(s.overrides, id);
          return {
            overrides: {
              ...s.overrides,
              [id]: {
                ...existing,
                followUps: [
                  ...existing.followUps,
                  { date: new Date().toISOString(), action, notes },
                ],
              },
            },
          };
        }),

      resetOverride: (id) =>
        set((s) => {
          const next = { ...s.overrides };
          delete next[id];
          return { overrides: next };
        }),

      setViewType: (viewType) => set({ viewType }),
      setSelectedId: (selectedId) => set({ selectedId }),
      setCurrentMonth: (currentMonth) => set({ currentMonth }),
      setShowTypes: (showTypes) => set({ showTypes }),
    }),
    { name: "mkcycles-calendar-v2" }
  )
);
