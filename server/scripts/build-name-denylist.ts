/**
 * Build the local real-names deny-list for `test-no-real-names` (A7) from the dummy Tally's ledger names.
 * READ ONLY on Tally (the preflight proves the open company is the dummy; one ledger read). It writes
 * `server/data/name-denylist.txt`, which is git-ignored, and prints COUNTS ONLY: no name ever reaches the screen,
 * a log or a commit (coordinator ruling D-M.180).
 *
 *   cd server; npx tsx scripts/build-name-denylist.ts
 *   cd server; npx tsx scripts/test-no-real-names.ts      (A7)
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { preflight } from "./rigs/lib/t11.js";
import { loadMasters, invalidateMasters } from "../src/services/tallyMasters.js";
import { selectDenyNames } from "./rigs/lib/denylist.js";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "name-denylist.txt");

(async () => {
  const pf = await preflight();
  invalidateMasters();
  const m = await loadMasters(pf.tallyUrl, pf.company, { force: true });
  const names = selectDenyNames([...m.ledgers.values()].map((l) => ({ name: l.name, parent: l.parent })));
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `# Local only, git-ignored. One real name per line. Built from the dummy's ledgers; never commit or print.\n${names.join("\n")}\n`, "utf8");
  console.log(`deny-list written: ${names.length} names from ${m.ledgers.size} ledgers (names not shown)`);
  process.exit(names.length ? 0 : 1);
})().catch((e) => { console.error(`FAILED: ${(e as Error).message}`); process.exit(2); });
