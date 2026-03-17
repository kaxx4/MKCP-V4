import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { UnitMode } from "../types/canonical";

interface UIState {
  unitMode: UnitMode;
  fyYear: string;       // "2024-2025"
  toggleUnitMode: () => void;
  setFyYear: (y: string) => void;
  sidebarOpen: boolean;
  setSidebarOpen: (v: boolean) => void;
  isMobile: boolean;
  setIsMobile: (v: boolean) => void;
  coverMonths: number;
  setCoverMonths: (n: number) => void;
  leadTimeMonths: number;
  setLeadTimeMonths: (n: number) => void;
  defaultCreditDays: number;
  setDefaultCreditDays: (n: number) => void;
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      unitMode: "BASE",
      fyYear: getCurrentFY(),
      sidebarOpen: typeof window !== "undefined" ? window.innerWidth >= 768 : true,
      isMobile: typeof window !== "undefined" ? window.innerWidth < 768 : false,
      coverMonths: 2,
      leadTimeMonths: 1.5,
      defaultCreditDays: 30,
      toggleUnitMode: () => set((s) => ({ unitMode: s.unitMode === "BASE" ? "PKG" : "BASE" })),
      setFyYear: (fyYear) => set({ fyYear }),
      setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
      setIsMobile: (isMobile) => set({ isMobile }),
      setCoverMonths: (coverMonths) => set({ coverMonths }),
      setLeadTimeMonths: (leadTimeMonths) => set({ leadTimeMonths }),
      setDefaultCreditDays: (defaultCreditDays) => set({ defaultCreditDays }),
    }),
    { name: "mkcycles-ui" }
  )
);

function getCurrentFY(): string {
  const now = new Date();
  const year = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return `${year}-${year + 1}`;
}
