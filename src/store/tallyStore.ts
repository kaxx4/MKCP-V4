import { create } from "zustand";
import { persist } from "zustand/middleware";

interface TallyConnectionState {
  proxyUrl: string;
  companyName: string;
  isConnected: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  isSyncing: boolean;
  autoSyncMinutes: number;
  fyFromDate: string;
  fyToDate: string;
  syncMode: "smart" | "monthly" | "daily" | "weekly";
  lastVoucherDate: string | null;
  lastMastersSyncAt: string | null;
  lastVouchersSyncAt: string | null;

  setProxyUrl: (url: string) => void;
  setCompanyName: (name: string) => void;
  setConnected: (v: boolean) => void;
  setLastSync: (at: string) => void;
  setLastError: (err: string | null) => void;
  setSyncing: (v: boolean) => void;
  setAutoSync: (minutes: number) => void;
  setFyDates: (from: string, to: string) => void;
  setSyncMode: (mode: "smart" | "monthly" | "daily" | "weekly") => void;
  resetToCurrentFY: () => void;
  setLastVoucherDate: (d: string | null) => void;
  setLastMastersSync: (at: string) => void;
  setLastVouchersSync: (at: string) => void;
}

export const useTallyStore = create<TallyConnectionState>()(
  persist(
    (set) => ({
      proxyUrl: "http://localhost:3100",
      companyName: "M.K.CYCLES (P) LTD.",
      isConnected: false,
      lastSyncAt: null,
      lastError: null,
      isSyncing: false,
      autoSyncMinutes: 0,
      fyFromDate: getDefaultFYStart(),
      fyToDate: getDefaultFYEnd(),
      syncMode: "smart",
      lastVoucherDate: null,
      lastMastersSyncAt: null,
      lastVouchersSyncAt: null,

      setProxyUrl: (proxyUrl) => set({ proxyUrl }),
      setCompanyName: (companyName) => set({ companyName }),
      setConnected: (isConnected) => set({ isConnected }),
      setLastSync: (lastSyncAt) => set({ lastSyncAt }),
      setLastError: (lastError) => set({ lastError }),
      setSyncing: (isSyncing) => set({ isSyncing }),
      setAutoSync: (autoSyncMinutes) => set({ autoSyncMinutes }),
      setFyDates: (fyFromDate, fyToDate) => set({ fyFromDate, fyToDate }),
      setSyncMode: (syncMode) => set({ syncMode }),
      setLastVoucherDate: (lastVoucherDate) => set({ lastVoucherDate }),
      setLastMastersSync: (lastMastersSyncAt) => set({ lastMastersSyncAt }),
      setLastVouchersSync: (lastVouchersSyncAt) => set({ lastVouchersSyncAt }),
      resetToCurrentFY: () => set({
        fyFromDate: getDefaultFYStart(),
        fyToDate: getDefaultFYEnd(),
      }),
    }),
    {
      name: "mkcycles-tally",
      partialize: (state) => {
        const { isSyncing, ...rest } = state;
        return rest;
      },
      version: 3,
      migrate: (persisted: any, version: number) => {
        if (version < 2) {
          persisted.fyFromDate = getDefaultFYStart();
          persisted.fyToDate = getDefaultFYEnd();
          persisted.syncMode = "smart";
        }
        if (version < 3) {
          persisted.lastVoucherDate = null;
          persisted.lastMastersSyncAt = null;
          persisted.lastVouchersSyncAt = null;
        }
        return persisted;
      },
      onRehydrateStorage: () => (state) => {
        if (state) {
          state.isSyncing = false;
          const from = state.fyFromDate;
          const to = state.fyToDate;
          if (!from || !to || from.length !== 8 || to.length !== 8 || from >= to) {
            state.fyFromDate = getDefaultFYStart();
            state.fyToDate = getDefaultFYEnd();
          }
          if (from === to) {
            state.fyFromDate = getDefaultFYStart();
            state.fyToDate = getDefaultFYEnd();
          }
        }
      },
    }
  )
);

export function getDefaultFYStart(): string {
  const now = new Date();
  const fyStartYear = now.getMonth() < 3 ? now.getFullYear() - 1 : now.getFullYear();
  return `${fyStartYear}0401`;
}

export function getDefaultFYEnd(): string {
  const now = new Date();
  const fyEndYear = now.getMonth() < 3 ? now.getFullYear() : now.getFullYear() + 1;
  return `${fyEndYear}0331`;
}
