/**
 * D-M.248 item 3 (runbook M1): register the office PC as the primary ERP machine. PRINTS SQL; changes nothing.
 * The machine key is made on the machine and never stored in the repo: only its sha-256 goes into the SQL.
 *
 *   npx tsx scripts/primary-register.ts --machine office-pc-1 --generate     make a key, show it ONCE, print the SQL
 *   MKCP_ERP_AGENT_KEY=... npx tsx scripts/primary-register.ts --machine office-pc-1   use the key already in server/.env (never printed)
 *
 * A person runs the printed statement in the database console (the service key cannot write erp_agent_machines, migration 0112).
 */
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { keyHashOf, registerSql, validMachineId } from "../src/services/primaryTools.js";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };
const machine = (arg("--machine") ?? process.env.MKCP_AGENT_MACHINE_ID ?? "").trim();
if (!validMachineId(machine)) { console.error(`--machine is needed: 3 to 64 letters, digits, dot, dash or underscore, such as office-pc-1 (got "${machine}")`); process.exit(2); }
const generate = process.argv.includes("--generate");
const key = generate ? randomBytes(32).toString("hex") : (process.env.MKCP_ERP_AGENT_KEY ?? "").trim();
if (!key) { console.error("No key: pass --generate, or set MKCP_ERP_AGENT_KEY in server/.env first."); process.exit(2); }
const sql = registerSql(machine, keyHashOf(key), arg("--note") ?? undefined);

console.log(`\nRegister the primary machine "${machine}"\n`);
if (generate) {
  console.log("1. Put these two lines in the agent's server/.env on the office PC. The key is shown only now and is not saved anywhere else:");
  console.log(`     MKCP_AGENT_MACHINE_ID=${machine}`);
  console.log(`     MKCP_ERP_AGENT_KEY=${key}`);
} else {
  console.log("1. The key is the one already in server/.env (not printed).");
}
console.log("\n2. Run this in the database console (an Owner or the database owner):\n");
console.log(sql.up);
console.log("\n3. Check it:\n");
console.log(sql.check);
console.log("\nUndo (rollback), if it must come out:\n");
console.log(sql.down);
console.log("\nThe machine does no work until the two switches are on (scripts/primary-switches.ts) and MKCP_PRIMARY_MODE=on is set on the office PC.\n");
