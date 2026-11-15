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
import { runPreflightLines } from "../src/services/primaryPreflight.js";
import { primaryPinProblem, primaryCompanyName } from "../src/services/primaryMode.js";
import { tallyCompany } from "../src/config/company.js";
import { supabaseClient, agentMachineId } from "../src/services/supabaseClient.js";
import { preflightText, type PreflightLine } from "../src/services/primaryTools.js";

(async () => {
  const tallyUrl = process.env.TALLY_URL || "http://localhost:9000";
  // the same checks the agent reports about itself on each start (D-M.286)
  const lines: PreflightLine[] = await runPreflightLines({
    tallyUrl, env: process.env, readListing: async () => (await tallyPost(tallyUrl, HEALTH_XML, 10_000, true)) as string, client: supabaseClient() as any,
  });
  const r = preflightText(lines);
  console.log(`\nPrimary preflight\n\n${r.text}\n`);
  process.exit(r.ready ? 0 : 1);
})().catch((e) => { console.error(`FAILED: ${(e as Error).message}`); process.exit(2); });
