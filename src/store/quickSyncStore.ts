import { create } from "zustand";
import type { PullResult } from "../services/tallyPull";

/** Shared result of the most recent quick sync (manual button OR scheduled),
 *  so the AgentStatus two-phase panel reflects both. */
export interface QuickSyncState {
  running: string | null;            // label of the sync currently running
  phase: "sync" | "push" | null;     // which phase is in progress
  tally?: PullResult;
  push?: { ok: boolean; items: number; ledgers: number; vouchers: number; configErr?: string | null; vouchersErr?: string | null };
  ok?: boolean;
  finishedAt?: string;
  auto?: boolean;                    // true when triggered by the scheduler
  /** Most recent scheduled sync that never ran because a guard tripped (another
   *  sync in flight, Tally not connected, no company configured). Purely
   *  informational — SyncStateIndicator only shows it while it's newer than
   *  `finishedAt`, so a subsequent real sync naturally supersedes it. */
  lastSkipped?: { label: string; reason: "sync-in-progress" | "not-connected" | "no-company"; at: string };
}

interface Store extends QuickSyncState {
  update: (s: Partial<QuickSyncState>) => void;
}

export const useQuickSyncStore = create<Store>((set) => ({
  running: null,
  phase: null,
  update: (s) => set(s),
}));
