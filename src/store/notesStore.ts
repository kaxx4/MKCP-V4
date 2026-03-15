import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface ItemNote {
  itemId: string;
  note: string;
  updatedAt: string;
}

interface NotesState {
  notes: Record<string, ItemNote>;  // keyed by itemId
  setNote: (itemId: string, note: string) => void;
  deleteNote: (itemId: string) => void;
  getNote: (itemId: string) => string;
  getAllNotes: () => ItemNote[];
}

export const useNotesStore = create<NotesState>()(
  persist(
    (set, get) => ({
      notes: {},
      setNote: (itemId, note) => set(state => ({
        notes: {
          ...state.notes,
          [itemId]: { itemId, note, updatedAt: new Date().toISOString() },
        },
      })),
      deleteNote: (itemId) => set(state => {
        const { [itemId]: _, ...rest } = state.notes;
        return { notes: rest };
      }),
      getNote: (itemId) => get().notes[itemId]?.note ?? "",
      getAllNotes: () => Object.values(get().notes).filter(n => n.note.trim()),
    }),
    { name: "mkcycles-item-notes" }
  )
);
