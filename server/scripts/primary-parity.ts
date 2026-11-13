/**
 * D-M.248 item 3 (runbook M9b): the parity check between today's tally_* tables and the new mirror's views, for the company, right before
 * `tally_swap` is turned on. The database function records its result (erp_swap_parity); the switch needs a passing result from the last 6 hours.
 *
 *   npx tsx scripts/primary-parity.ts [--company "<name>"]          prints the call and the console statement; changes nothing
 *   npx tsx scripts/primary-parity.ts [--company "<name>"] --run    runs it through the agent's database key and prints the verdict
 *
 * Exit 0 only when the database says passed with its tables and no reason. No database (a sandbox machine) is "cannot run", exit 2, never a pass.
 */
import "dotenv/config";
import { supabaseClient } from "../src/services/supabaseClient.js";
import { primaryCompanyName } from "../src/services/primaryMode.js";
import { tallyCompany } from "../src/config/company.js";
import { parityVerdict, sqlStr } from "../src/services/primaryTools.js";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };
(async () => {
  const company = arg("--company") ?? (primaryCompanyName() || tallyCompany());
  const stmt = `select public.erp_tally_parity(${sqlStr(company)}, false);`;
  console.log(`\nParity for "${company}" (compares tally_* with the new views; records one row in erp_swap_parity)\n\nConsole statement, if you prefer to run it there:\n  ${stmt}\n`);
  if (!process.argv.includes("--run")) { console.log("Dry run: nothing was called. Add --run to call it.\n"); process.exit(0); }
  const c = supabaseClient();
  if (!c) { console.error("CANNOT RUN: this machine has no database client (sandbox, offline, or no service key). Run it on the office PC, or use the console statement above."); process.exit(2); }
  const { data, error } = await c.rpc("erp_tally_parity", { p_company: company, p_is_test: false });
  if (error) { console.error(`CANNOT RUN: ${error.message}`); process.exit(2); }
  const v = parityVerdict(data);
  for (const l of v.lines) console.log(`  ${l}`);
  console.log(`\n  PARITY ${v.pass ? "PASSED" : "FAILED"}${v.pass ? "; turn tally_swap on within 6 hours, and before any other write to the swap store" : ""}\n`);
  process.exit(v.pass ? 0 : 1);
})().catch((e) => { console.error(`FAILED: ${(e as Error).message}`); process.exit(2); });
