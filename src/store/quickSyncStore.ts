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
}

interface Store extends QuickSyncState {
  update: (s: QuickSyncState) => void;
}

export const useQuickSyncStore = create<Store>((set) => ({
  running: null,
  phase: null,
  update: (s) => set(s),
}));
