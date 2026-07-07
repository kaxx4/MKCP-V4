import { useQuickSyncStore } from "../store/quickSyncStore";
import { useSupabaseSyncStatusStore } from "../store/supabaseSyncStatusStore";
import { useDataStore } from "../store/dataStore";
import { useTallyStore } from "../store/tallyStore";
import { pullFromTally, retryIncompleteVouchers } from "./tallyPull";
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
  if (useTallyStore.getState().isSyncing || useQuickSyncStore.getState().running) {
    // Surface the skip — without this, a collided scheduled sync leaves the
    // indicator showing whatever the in-flight sync (or stale prior state) was,
    // making a skip indistinguishable from nothing happening at all. Only
    // lastSkipped is touched — running/phase/finishedAt keep reflecting the
    // sync that's actually in flight.
    useQuickSyncStore.getState().update({
      lastSkipped: { label, reason: "sync-in-progress", at: new Date().toISOString() },
    });
    return;
  }
  useTallyStore.getState().setSyncing(true);
  const qs = useQuickSyncStore.getState();
  qs.update({ running: label, phase: "sync", auto });

  // Tags every request this sync sends to the server so [SYNC] log lines can be
  // attributed back to which trigger fired — "manual" (button) vs
  // "scheduled-<label>" (e.g. "scheduled-today", "scheduled-last-7-days").
  // Log-only: never read for behavior.
  const origin = auto ? `scheduled-${label.toLowerCase().replace(/\s+/g, "-")}` : "manual";

  try {
    // Phase 1 — Tally → app (server also mirrors pulled vouchers to Supabase).
    const tally = await pullFromTally(company, fromYmd, toYmd, "daily", origin);
    if (!tally.ok) {
      useQuickSyncStore.getState().update({ running: null, phase: null, tally, ok: false, auto, finishedAt: new Date().toISOString() });
      return;
    }

    // If any vouchers came back with zero ledger/inventory lines, attempt exactly
    // ONE targeted re-fetch scoped to their date span before pushing — this is what
    // turns a routine "run a full sync to backfill" into an automatic recovery.
    // Never blocks/throws: whatever remains incomplete after this stays flagged in
    // tally.incompleteVoucherIds for the UI's existing banner.
    if (tally.incompleteVoucherIds?.length) {
      const data = useDataStore.getState().data;
      const stillIncomplete = await retryIncompleteVouchers(
        company,
        tally.incompleteVoucherIds,
        data?.vouchers ?? [],
        origin
      );
      tally.incompleteVoucherIds = stillIncomplete.length > 0 ? stillIncomplete : undefined;
      if (stillIncomplete.length > 0) {
        console.warn(`[quickSync] ${stillIncomplete.length} voucher(s) still missing lines after auto-retry`);
      }
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
