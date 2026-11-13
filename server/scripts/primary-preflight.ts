/**
 * D-M.248 item 3 (runbook D4): the preflight for the office PC. READ-ONLY: it reads the settings, asks Tally for its company list (one request),
 * and asks the database whether this machine's key is registered as a primary (erp_my_open_jobs, a read; it takes no lease and claims nothing).
 * It never starts the mode and never prints a key.
 *
 *   npx tsx scripts/primary-preflight.ts
 *
 * Exit 0 only when every line is READY.
 */
import "dotenv/config";
import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { readPrimaryConfig } from "../src/services/primaryRunner.js";
import { primaryPinProblem, primaryCompanyName } from "../src/services/primaryMode.js";
import { tallyCompany } from "../src/config/company.js";
import { supabaseClient } from "../src/services/supabaseClient.js";
import { preflightText, type PreflightLine } from "../src/services/primaryTools.js";

(async () => {
  const tallyUrl = process.env.TALLY_URL || "http://localhost:9000";
  const lines: PreflightLine[] = [];
  const cfg = readPrimaryConfig(tallyUrl);
  if (cfg.ok) lines.push({ name: "the primary settings are complete", ok: true, detail: "" });
  else for (const p of cfg.problems) lines.push({ name: "setting", ok: false, detail: p });

  let listing = "";
  try { listing = (await tallyPost(tallyUrl, HEALTH_XML, 10_000, true)) as string; lines.push({ name: "Tally answers on its port", ok: true, detail: "" }); }
  catch (e) { lines.push({ name: "Tally answers on its port", ok: false, detail: (e as Error).message.slice(0, 120) }); }

  if (listing) {
    const why = primaryPinProblem(primaryCompanyName() || tallyCompany(), listing);
    lines.push({ name: "the open company carries the pinned GUID", ok: !why, detail: why ? why.replace(/\s*Nothing was sent to Tally\.?$/, "") : "" });
  }

  const c = supabaseClient();
  if (!c) lines.push({ name: "the database is reachable and this machine's key is registered as primary", ok: false, detail: "no database client on this machine (sandbox, offline or no service key)" });
  else {
    const { error } = await c.rpc("erp_my_open_jobs", {});
    lines.push({ name: "the database is reachable and this machine's key is registered as primary", ok: !error, detail: error ? error.message.slice(0, 120) : "" });
  }

  const r = preflightText(lines);
  console.log(`\nPrimary preflight\n\n${r.text}\n`);
  process.exit(r.ready ? 0 : 1);
})().catch((e) => { console.error(`FAILED: ${(e as Error).message}`); process.exit(2); });
