/**
 * D-M.248 item 3 (runbook M1, M2): the exact SQL that turns the two database switches on and off. PRINTS SQL; changes nothing.
 *   live_claims  (erp_control)       a primary machine is handed real jobs
 *   live_mirror  (erp_sync_control)  a primary machine's mirror sync is accepted
 * Both are off until a row says on. The service key cannot write either table, so a person runs the statement in the console.
 *
 *   npx tsx scripts/primary-switches.ts live_claims on|off
 *   npx tsx scripts/primary-switches.ts live_mirror on|off
 *   npx tsx scripts/primary-switches.ts check
 */
import { switchSql, switchCheckSql, type SwitchName } from "../src/services/primaryTools.js";

const [which, state] = process.argv.slice(2);
if (which === "check") { console.log(`\n${switchCheckSql()}\n`); process.exit(0); }
if ((which !== "live_claims" && which !== "live_mirror") || (state !== "on" && state !== "off")) {
  console.error("usage: primary-switches.ts live_claims|live_mirror on|off   (or: check)");
  process.exit(2);
}
console.log(`\n-- ${which} ${state.toUpperCase()}\n${switchSql(which as SwitchName, state === "on")}\n\n-- read it back\n${switchCheckSql()}\n`);
