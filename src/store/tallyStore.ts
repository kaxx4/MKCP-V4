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

function getDefaultFYStart(): string {
  const now = new Date();
  const year = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return `${year}0401`;
}

function getDefaultFYEnd(): string {
  const now = new Date();
  const year = now.getMonth() >= 3 ? now.getFullYear() + 1 : now.getFullYear();
  return `${year}0331`;
}
