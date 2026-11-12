/**
 * T11 preflight, read only: is the open company the dummy, and does Tally answer?
 * Reads the company list once. Writes nothing. Exit 0 = every safety line holds.
 *   npx tsx scripts/rigs/t11-preflight.ts
 */
import "dotenv/config";
import { preflight } from "./lib/t11.js";

preflight()
  .then((p) => { console.log(`preflight ok: the dummy is the only company open, company list answered in ${p.listMs} ms, TALLY_URL is loopback, role is sandbox`); process.exit(0); })
  .catch((e) => { console.error(`preflight FAILED: ${(e as Error).message}`); process.exit(2); });
