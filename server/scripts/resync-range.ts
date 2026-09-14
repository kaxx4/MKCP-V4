/**
 * Re-pull a date range of vouchers from Tally into the mirror.
 *
 * ── Why this is needed at all ─────────────────────────────────────────────
 *
 * 61% of vouchers here are entered BACKDATED. A sync that re-pulls "recent
 * dates" never sees an order keyed on the 9th but dated the 5th, because the
 * 5th was synced on the 5th and is not looked at again.
 *
 * That is not hypothetical: on 14-Sep-2026 Tally held 16 Sales Order Notes in
 * the QUOTE series and the mirror held 10. The six missing ones were dated
 * 5–8 Sep — days the mirror HAD synced, and for which it holds payments,
 * purchases, receipts and sales. Only the order notes were absent, because they
 * were typed later. Dispatch could not show them, so 11 open orders looked like
 * the whole truck when it was not.
 *
 * Reads from Tally, upserts to the mirror. Nothing is written to Tally.
 */
/* The env lives at server/.env, NOT at the repo root. `dotenv/config` loads
   from the CWD, so running this from the repo root silently gave a
   credential-less SupabaseSync — which does not throw, it just returns early
   from every write. A "re-sync" that wrote nothing and reported success. */
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
loadEnv({ path: join(dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import { SyncOrchestrator } from "../src/services/syncOrchestrator.js";
import { SupabaseSync } from "../src/services/supabaseSync.js";

const [, , from, to] = process.argv;
const COMPANY = process.env.SYNC_COMPANY || "M.K.CYCLES (P) LTD. - (from 1-Apr-26)";
const TALLY = process.env.TALLY_URL || "http://localhost:9000";

if (!from || !to || !/^\d{8}$/.test(from) || !/^\d{8}$/.test(to)) {
  console.error("usage: resync-range <YYYYMMDD> <YYYYMMDD>");
  process.exit(1);
}

(async () => {
  const supabase = new SupabaseSync();
  const orch = new SyncOrchestrator(TALLY, supabase);
  console.log(`Re-pulling ${from} → ${to} for "${COMPANY}"`);
  const res = await orch.syncVouchersOnly(COMPANY, from, to, "daily", undefined, (p) => {
    if (p.detail) console.log(`  [${p.phase}] ${p.step}/${p.totalSteps} ${p.detail}`);
  });
  console.log("\nresult:", JSON.stringify({ ok: (res as any).success ?? true, counts: (res as any).counts ?? res }, null, 2).slice(0, 1200));
})().catch((e) => { console.error(e); process.exit(1); });
