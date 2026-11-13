/**
 * D-M.248 item 3 (runbook D4): the preflight for the office PC. READ-ONLY: it reads the settings, asks Tally for its company list (one request),
 * and asks the database for THIS machine's role with its own id and key (erp_agent_role(p_machine, p_key): a read; it takes no lease and claims
 * nothing). A key the database does not know, or one registered as a sandbox, is NOT READY. It never starts the mode and never prints a key.
 *
 * HOW TO USE IT (D-M.256 item 3): put every setting in the office PC's .env first (MKCP_PRIMARY_MODE=on, MKCP_PRIMARY_COMPANY_GUID,
 * MKCP_AGENT_MACHINE_ID, MKCP_ERP_AGENT_KEY, an absolute MKCP_ERP_JOURNAL_PATH), then run this with the agent STOPPED. "MKCP_PRIMARY_MODE is not
 * on" is deliberately a failure: a preflight that passes with the mode off proves nothing about the mode.
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
import { supabaseClient, agentMachineId } from "../src/services/supabaseClient.js";
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
    const machine = agentMachineId();
    const key = (process.env.MKCP_ERP_AGENT_KEY ?? "").trim();
    if (machine === "unnamed-machine" || !key) lines.push({ name: "the database is reachable and this machine's key is registered as primary", ok: false, detail: "no machine id or key to ask with" });
    else {
      const { data, error } = await c.rpc("erp_agent_role", { p_machine: machine, p_key: key });
      const role = typeof data === "string" ? data : null;
      lines.push({ name: "the database is reachable and this machine's key is registered as primary", ok: !error && role === "primary",
        detail: error ? error.message.slice(0, 120) : role === "primary" ? "" : `the database says role "${role ?? "none"}", not primary` });
    }
  }

  const r = preflightText(lines);
  console.log(`\nPrimary preflight\n\n${r.text}\n`);
  process.exit(r.ready ? 0 : 1);
})().catch((e) => { console.error(`FAILED: ${(e as Error).message}`); process.exit(2); });
