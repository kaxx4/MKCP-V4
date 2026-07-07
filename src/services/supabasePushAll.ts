import { useDataStore } from "../store/dataStore";
import { syncConfigToSupabase } from "../hooks/useSupabaseConfigSync";
import { useSupabaseSyncStatusStore } from "../store/supabaseSyncStatusStore";

const BASE = "http://localhost:3100";
const SERVER_URL = `${BASE}/api/supabase/sync`;

// Module-level in-flight guard — prevents concurrent full-payload pushes.
let pushing = false;

/**
 * Block until the SERVER reports no Tally pull in flight. A push that runs while
 * Tally is being pulled would ship a half-updated snapshot and miss the window.
 * We check the server busy flag (not the local isSyncing lock, which the caller
 * runQuickSync holds for the whole pull+push — checking it here would deadlock).
 * Bounded so it never hangs.
 */
async function waitForTallyIdle(maxMs = 15 * 60 * 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    let serverBusy = false;
    try {
      const h = await fetch(`${BASE}/api/tally/health`).then((r) => r.json());
      serverBusy = !!h.busy;
    } catch { /* server unreachable — don't block forever */ }
    if (!serverBusy) return;
    await new Promise((r) => setTimeout(r, 1500));
  }
  console.warn("[push] Tally still busy after wait cap — pushing anyway");
}

export async function pushAll(label: string): Promise<{ mastersVouchersOk: boolean; configOk: boolean }> {
  if (pushing) {
    console.log(`[${label}] Skipping — push already in flight`);
    return { mastersVouchersOk: true, configOk: true };
  }

  pushing = true;
  try {
    // Never push while a Tally sync is running — wait it out first.
    await waitForTallyIdle();

    const status = useSupabaseSyncStatusStore.getState();
    const data = useDataStore.getState().data;
    if (!data) {
      console.warn(`[${label}] No local data to push (still loading?)`);
      return { mastersVouchersOk: true, configOk: true };
    }
    const company = data.company?.name || "M.K.CYCLES (P) LTD.";

    const items = Array.from(data.items.values());
    const ledgers = Array.from(data.ledgers.values());

    // Vouchers are deliberately NOT sent here. They already have a correctly
    // per-day-pruned push via the orchestrator's Phase-1 sync-daybook upload
    // (see syncOrchestrator.ts). This endpoint used to also re-upload the ENTIRE
    // local voucher array as a pure upsert with no pruning metadata — if the
    // local store hadn't cleared a deleted voucher yet (e.g. a converted/removed
    // Delivery Note), this second push re-inserted exactly what Phase 1 had just
    // deleted, in the same cycle. That's the bug this fixes.
    console.log(`[${label}] Firing — config + ${items.length} items + ${ledgers.length} ledgers (vouchers pushed separately, per-day-pruned)`);

    const [configResult, mastersResp] = await Promise.allSettled([
      syncConfigToSupabase(company),
      fetch(SERVER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ company, items, ledgers }),
      }).then(async (r) => {
        const j = await r.json();
        if (!r.ok || !j.success) throw new Error(j.error || `HTTP ${r.status}`);
        return j;
      }),
    ]);

    const configOk =
      configResult.status === "fulfilled" &&
      configResult.value.success &&
      (!configResult.value.errors || configResult.value.errors.length === 0);

    if (configResult.status === "fulfilled" && configResult.value.success) {
      console.log(`[${label}] ✓ Config synced:`, configResult.value.counts);
      if (configResult.value.errors?.length) {
        console.warn(`[${label}] Config had per-table errors:`, configResult.value.errors);
      }
    } else {
      console.warn(`[${label}] Config sync failed:`, configResult.status === "fulfilled" ? configResult.value.errors : configResult.reason);
    }

    // NOTE: "vouchers" status is intentionally NOT recorded here anymore — it's
    // now fed from tallyPull.ts's pullFromTally, reflecting the orchestrator's
    // actual per-day-pruned upload result (see comment above), not this
    // masters-only call. The `mastersVouchersOk` name is kept for now since
    // quickSync.ts/AgentStatus.tsx already read it as "did phase 2 succeed";
    // it now purely reflects the masters push outcome.
    let mastersVouchersOk: boolean;
    if (mastersResp.status === "fulfilled") {
      console.log(`[${label}] ✓ Masters synced:`, mastersResp.value);
      status.recordResult("masters", true);
      mastersVouchersOk = true;
    } else {
      const errMsg = (mastersResp.reason as any)?.message || String(mastersResp.reason);
      console.warn(`[${label}] Masters sync rejected: ${errMsg}`);
      status.recordResult("masters", false, errMsg);
      mastersVouchersOk = false;
    }

    return { mastersVouchersOk, configOk };
  } finally {
    pushing = false;
  }
}
