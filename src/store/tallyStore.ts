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
    { name: "mkcycles-tally" }
  )
);

/**
 * Calculate default FY start date - uses the PREVIOUS completed FY
 * This ensures we're fetching actual historical data, not future dates
 * Example: If today is March 2026, return April 1, 2024 (start of FY 2024-25)
 */
function getDefaultFYStart(): string {
  const now = new Date();
  // Always go back one full FY to get completed data
  const fyStartYear = now.getMonth() < 3 ? now.getFullYear() - 2 : now.getFullYear() - 1;
  return `${fyStartYear}0401`;
}

/**
 * Calculate default FY end date - end of the PREVIOUS completed FY
 * Example: If today is March 2026, return March 31, 2025 (end of FY 2024-25)
 */
function getDefaultFYEnd(): string {
  const now = new Date();
  // End date is one year after start
  const fyEndYear = now.getMonth() < 3 ? now.getFullYear() - 1 : now.getFullYear();
  return `${fyEndYear}0331`;
}
