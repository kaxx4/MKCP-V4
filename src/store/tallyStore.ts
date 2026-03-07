import { create } from "zustand";
import { persist } from "zustand/middleware";

interface TallyConnectionState {
  // Connection settings
  proxyUrl: string;
  companyName: string;
  isConnected: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  isSyncing: boolean;
  autoSyncMinutes: number;  // 0 = disabled

  // FY date range for voucher fetching
  fyFromDate: string;  // "20240401"
  fyToDate: string;    // "20250331"

  // Actions
  setProxyUrl: (url: string) => void;
  setCompanyName: (name: string) => void;
  setConnected: (v: boolean) => void;
  setLastSync: (at: string) => void;
  setLastError: (err: string | null) => void;
  setSyncing: (v: boolean) => void;
  setAutoSync: (minutes: number) => void;
  setFyDates: (from: string, to: string) => void;
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

      setProxyUrl: (proxyUrl) => set({ proxyUrl }),
      setCompanyName: (companyName) => set({ companyName }),
      setConnected: (isConnected) => set({ isConnected }),
      setLastSync: (lastSyncAt) => set({ lastSyncAt }),
      setLastError: (lastError) => set({ lastError }),
      setSyncing: (isSyncing) => set({ isSyncing }),
      setAutoSync: (autoSyncMinutes) => set({ autoSyncMinutes }),
      setFyDates: (fyFromDate, fyToDate) => set({ fyFromDate, fyToDate }),
    }),
    {
      name: "mkcycles-tally",
      partialize: (state) => {
        // Exclude isSyncing from persistence — it's transient runtime state.
        // If a sync hangs, we don't want buttons stuck disabled forever.
        const { isSyncing, ...rest } = state;
        return rest;
      },
      version: 1,
      migrate: (persisted: any, version: number) => {
        if (version < 1) {
          // v0 → v1: Fix FY dates from "previous FY" to "current FY"
          persisted.fyFromDate = getDefaultFYStart();
          persisted.fyToDate = getDefaultFYEnd();
        }
        return persisted;
      },
      onRehydrateStorage: () => (state) => {
        // Always reset isSyncing on page load — clear any stuck state
        if (state) state.isSyncing = false;
      },
    }
  )
);

/**
 * Calculate default FY start date - uses the CURRENT financial year.
 * Indian FY: April 1 to March 31.
 * Example: If today is March 2026, current FY = April 1, 2025 → March 31, 2026.
 */
function getDefaultFYStart(): string {
  const now = new Date();
  // If Jan-Mar (month 0-2), FY started previous calendar year; else this year
  const fyStartYear = now.getMonth() < 3 ? now.getFullYear() - 1 : now.getFullYear();
  return `${fyStartYear}0401`;
}

/**
 * Calculate default FY end date - end of the CURRENT financial year.
 * Example: If today is March 2026, return March 31, 2026.
 */
function getDefaultFYEnd(): string {
  const now = new Date();
  const fyEndYear = now.getMonth() < 3 ? now.getFullYear() : now.getFullYear() + 1;
  return `${fyEndYear}0331`;
}
