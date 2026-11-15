/**
 * D-M.248 item 3 (runbook M1, M2): the exact SQL that turns the two database switches on and off. PRINTS SQL; changes nothing.
 *   live_claims  (erp_control)       a primary machine is handed real jobs
 *   live_mirror  (erp_sync_control)  a primary machine's mirror sync is accepted
 * Both are off until a row says on. The service key cannot write either table, so a person runs the statement in the console.
 *
 *   npx tsx scripts/primary-switches.ts live_claims on|off
 *   npx tsx scripts/primary-switches.ts live_mirror on|off
 *   npx tsx scripts/primary-switches.ts check
 *
 * D-M.281: the one script here that writes. When the mirror holds back a voucher type that vanished from Tally's read (a mass disappearance:
 * 3 or more vouchers of the type), /api/primary/status shows it under mirror.holds. If those vouchers really are gone from Tally, an Owner
 * releases the hold ONCE with
 *   npx tsx scripts/primary-switches.ts ack-vanish "Sales Order Note"
 * It appends a "vanish-ack" line to the agent's own journal (MKCP_ERP_JOURNAL_PATH, an absolute path; the agent may be running). The next run
 * that prunes that type uses it up; a later vanishing holds again. It is refused unless the journal already holds the alarm for that type, and an
 * acknowledgement not used within 24 hours is ignored. No database change.
 */
import "dotenv/config";
import { isAbsolute } from "node:path";
import { Journal } from "../src/services/erpJobAgent.js";
import { vanishAckFor } from "../src/services/mirrorGuards.js";
import { switchSql, switchCheckSql, type SwitchName } from "../src/services/primaryTools.js";

const [which, state] = process.argv.slice(2);
if (which === "ack-vanish") {
  const path = (process.env.MKCP_ERP_JOURNAL_PATH ?? "").trim();
  if (!path || !isAbsolute(path)) { console.error("MKCP_ERP_JOURNAL_PATH must be set to the agent's journal file (an absolute path)."); process.exit(2); }
  const journal = new Journal(path);
  const verdict = vanishAckFor(journal.entries() as { kind: string; alarm?: string }[], state ?? "", new Date().toISOString());
  if (!verdict.ok) { console.error(`refused: ${verdict.reason}`); process.exit(2); }
  journal.append(verdict.entry);
  console.log(`acknowledged: the next mirror run that prunes "${verdict.entry.type}" is released once. Nothing else changed.`);
  process.exit(0);
}
if (which === "check") { console.log(`\n${switchCheckSql()}\n`); process.exit(0); }
if ((which !== "live_claims" && which !== "live_mirror") || (state !== "on" && state !== "off")) {
  console.error("usage: primary-switches.ts live_claims|live_mirror on|off   (or: check, or: ack-vanish \"<voucher type>\")");
  process.exit(2);
}
console.log(`\n-- ${which} ${state.toUpperCase()}\n${switchSql(which as SwitchName, state === "on")}\n\n-- read it back\n${switchCheckSql()}\n`);
