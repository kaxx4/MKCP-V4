import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface CallingListEntry {
  partyName: string;
  partyLedgerId: string;
  phone?: string;
  email?: string;
  items: { itemId: string; itemName: string; suggestedQty: number; baseUnit: string }[];
  note?: string;
  called: boolean;
  calledAt?: string;
  addedAt: string;
}

interface CallingListState {
  entries: CallingListEntry[];
  addEntry: (entry: Omit<CallingListEntry, "called" | "addedAt">) => void;
  addEntries: (entries: Omit<CallingListEntry, "called" | "addedAt">[]) => void;
  markCalled: (partyLedgerId: string) => void;
  removeEntry: (partyLedgerId: string) => void;
  clearAll: () => void;
  updateNote: (partyLedgerId: string, note: string) => void;
}

export const useCallingListStore = create<CallingListState>()(
  persist(
    (set) => ({
      entries: [],
      addEntry: (entry) => set(state => {
        // Don't add duplicates
        if (state.entries.some(e => e.partyLedgerId === entry.partyLedgerId)) {
          return { entries: state.entries.map(e =>
            e.partyLedgerId === entry.partyLedgerId
              ? { ...e, items: entry.items, note: entry.note }
              : e
          )};
        }
        return { entries: [...state.entries, { ...entry, called: false, addedAt: new Date().toISOString() }] };
      }),
      addEntries: (entries) => set(state => {
        const existing = new Set(state.entries.map(e => e.partyLedgerId));
        const newEntries = entries
          .filter(e => !existing.has(e.partyLedgerId))
          .map(e => ({ ...e, called: false, addedAt: new Date().toISOString() }));
        return { entries: [...state.entries, ...newEntries] };
      }),
      markCalled: (partyLedgerId) => set(state => ({
        entries: state.entries.map(e =>
          e.partyLedgerId === partyLedgerId
            ? { ...e, called: true, calledAt: new Date().toISOString() }
            : e
        ),
      })),
      removeEntry: (partyLedgerId) => set(state => ({
        entries: state.entries.filter(e => e.partyLedgerId !== partyLedgerId),
      })),
      clearAll: () => set({ entries: [] }),
      updateNote: (partyLedgerId, note) => set(state => ({
        entries: state.entries.map(e =>
          e.partyLedgerId === partyLedgerId ? { ...e, note } : e
        ),
      })),
    }),
    { name: "mkcycles-calling-list" }
  )
);

/** Export calling list as CSV string */
export function exportCallingListCSV(entries: CallingListEntry[]): string {
  const headers = ["Party Name", "Phone", "Email", "Items", "Quantities", "Note", "Called", "Called At"];
  const rows = entries.map(e => [
    e.partyName,
    e.phone ?? "",
    e.email ?? "",
    e.items.map(i => i.itemName).join("; "),
    e.items.map(i => `${i.suggestedQty} ${i.baseUnit}`).join("; "),
    e.note ?? "",
    e.called ? "Yes" : "No",
    e.calledAt ?? "",
  ]);
  return [headers, ...rows].map(r => r.map(c => `"${c.replace(/"/g, '""')}"`).join(",")).join("\n");
}
