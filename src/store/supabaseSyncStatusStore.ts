import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Tracks the outcome of the most recent Supabase auto-push attempts.
 *
 * Three channels:
 *   • config   — /api/supabase/sync-config  (13 config tables)
 *   • masters  — /api/supabase/sync         (items + ledgers, half of the payload)
 *   • vouchers — /api/supabase/sync         (vouchers + inventory + ledger entries)
 *
 * Auto-push hooks (2s debounce, 5-min-after-tally, 15-min interval) and the
 * Settings "Push EVERYTHING" button all write here so we can:
 *   1. Show a single "Cloud sync" health indicator in the NavBar.
 *   2. Trigger a fast 60s retry when any channel fails (instead of waiting
 *      the full 15 min for the next interval tick).
 */
export type SyncChannel = "config" | "masters" | "vouchers";

export interface ChannelStatus {
  lastAt: string | null;      // ISO timestamp of most recent attempt
  success: boolean | null;    // null = never attempted
  error: string | null;       // error message if last attempt failed
  retryScheduled: boolean;    // true while a 60s retry timer is pending
}

interface SupabaseSyncStatusStore {
  config: ChannelStatus;
  masters: ChannelStatus;
  vouchers: ChannelStatus;
  recordResult: (channel: SyncChannel, success: boolean, error?: string | null) => void;
  setRetryScheduled: (channel: SyncChannel, scheduled: boolean) => void;
  isAnyFailed: () => boolean;
  allSuccess: () => boolean;
}

const EMPTY: ChannelStatus = { lastAt: null, success: null, error: null, retryScheduled: false };

export const useSupabaseSyncStatusStore = create<SupabaseSyncStatusStore>()(
  persist(
    (set, get) => ({
      config: EMPTY,
      masters: EMPTY,
      vouchers: EMPTY,
      recordResult: (channel, success, error = null) =>
        set((s) => ({
          [channel]: {
            lastAt: new Date().toISOString(),
            success,
            error: success ? null : error,
            retryScheduled: s[channel].retryScheduled,
          },
        }) as Partial<SupabaseSyncStatusStore>),
      setRetryScheduled: (channel, scheduled) =>
        set((s) => ({
          [channel]: { ...s[channel], retryScheduled: scheduled },
        }) as Partial<SupabaseSyncStatusStore>),
      isAnyFailed: () => {
        const s = get();
        return s.config.success === false || s.masters.success === false || s.vouchers.success === false;
      },
      allSuccess: () => {
        const s = get();
        return s.config.success === true && s.masters.success === true && s.vouchers.success === true;
      },
    }),
    {
      name: "mk_supabase_sync_status",
      partialize: (s) => ({ config: s.config, masters: s.masters, vouchers: s.vouchers }),
    }
  )
);
