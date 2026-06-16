import { useDataStore } from "../store/dataStore";
import { useTallyStore } from "../store/tallyStore";
import { syncConfigToSupabase } from "../hooks/useSupabaseConfigSync";
import { useSupabaseSyncStatusStore } from "../store/supabaseSyncStatusStore";

const BASE = "http://localhost:3100";
const SERVER_URL = `${BASE}/api/supabase/sync`;

// Module-level in-flight guard — prevents concurrent full-payload pushes.
let pushing = false;

/**
 * Block until no Tally sync is in flight (locally OR on the server). A push that
 * runs mid-sync would ship a half-updated snapshot and miss the window, so the
 * push always waits for the sync to finish first. Bounded so it never hangs.
 */
async function waitForTallyIdle(maxMs = 15 * 60 * 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const localSyncing = useTallyStore.getState().isSyncing;
    let serverBusy = false;
    try {
      const h = await fetch(`${BASE}/api/tally/health`).then((r) => r.json());
      serverBusy = !!h.busy;
    } catch { /* server unreachable — don't block forever */ }
    if (!localSyncing && !serverBusy) return;
    await new Promise((r) => setTimeout(r, 1500));
  }
  console.warn("[push] Tally sync still running after wait cap — pushing anyway");
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
    const vouchers = data.vouchers;

    console.log(`[${label}] Firing — config + ${items.length} items + ${ledgers.length} ledgers + ${vouchers.length} vouchers`);

    const [configResult, voucherResp] = await Promise.allSettled([
      syncConfigToSupabase(company),
      fetch(SERVER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ company, items, ledgers, vouchers }),
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

    let mastersVouchersOk: boolean;
    if (voucherResp.status === "fulfilled") {
      console.log(`[${label}] ✓ Masters + vouchers synced:`, voucherResp.value);
      status.recordResult("masters", true);
      status.recordResult("vouchers", true);
      mastersVouchersOk = true;
    } else {
      const errMsg = (voucherResp.reason as any)?.message || String(voucherResp.reason);
      console.warn(`[${label}] Masters + vouchers sync rejected: ${errMsg}`);
      status.recordResult("masters", false, errMsg);
      status.recordResult("vouchers", false, errMsg);
      mastersVouchersOk = false;
    }

    return { mastersVouchersOk, configOk };
  } finally {
    pushing = false;
  }
}
