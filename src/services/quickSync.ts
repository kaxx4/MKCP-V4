import { useQuickSyncStore } from "../store/quickSyncStore";
import { useSupabaseSyncStatusStore } from "../store/supabaseSyncStatusStore";
import { useDataStore } from "../store/dataStore";
import { useTallyStore } from "../store/tallyStore";
import { pullFromTally } from "./tallyPull";
import { pushAll } from "./supabasePushAll";

/**
 * One quick sync = pull from Tally (daily chunks) for [fromYmd, toYmd], then
 * push everything to Supabase — strictly sequential. pullFromTally holds the
 * global isSyncing lock and pushAll waits for Tally to be idle, so:
 *   • the push never runs mid-pull (can't miss a window), and
 *   • two quick syncs never overlap (a second one no-ops while one is running).
 * Result is written to the shared quickSyncStore so the UI panel reflects it.
 */
export async function runQuickSync(company: string, label: string, fromYmd: string, toYmd: string, auto = false): Promise<void> {
  // GLOBAL mutex — one sync (manual OR scheduled) at a time. isSyncing is held for
  // the WHOLE pull+push so nothing else can start mid-operation. Skip if anything
  // (a manual Pull-Sync button, another quick sync) is already running.
  if (useTallyStore.getState().isSyncing || useQuickSyncStore.getState().running) return;
  useTallyStore.getState().setSyncing(true);
  const qs = useQuickSyncStore.getState();
  qs.update({ running: label, phase: "sync", auto });

  try {
    // Phase 1 — Tally → app (server also mirrors pulled vouchers to Supabase).
    const tally = await pullFromTally(company, fromYmd, toYmd, "daily");
    if (!tally.ok) {
      useQuickSyncStore.getState().update({ running: null, phase: null, tally, ok: false, auto, finishedAt: new Date().toISOString() });
      return;
    }

    // Phase 2 — push the full local store (config + masters + vouchers) to Supabase.
    useQuickSyncStore.getState().update({ running: label, phase: "push", tally, auto });
    const pr = await pushAll(`quick:${label}`);
    const st = useSupabaseSyncStatusStore.getState();
    const data = useDataStore.getState().data;
    const pushOk = pr.mastersVouchersOk && pr.configOk;
    useQuickSyncStore.getState().update({
      running: null, phase: null, tally, ok: tally.ok && pushOk, auto,
      finishedAt: new Date().toISOString(),
      push: {
        ok: pushOk,
        items: data?.items.size ?? 0,
        ledgers: data?.ledgers.size ?? 0,
        vouchers: data?.vouchers.length ?? 0,
        configErr: pr.configOk ? null : st.config.error,
        vouchersErr: pr.mastersVouchersOk ? null : st.vouchers.error,
      },
    });
  } finally {
    useTallyStore.getState().setSyncing(false);
  }
}
