/**
 * #118: static check that migrations are safe to run twice.
 *
 * Flags, per migrations/*.sql file:
 *   - a top-level `DROP TABLE`, with or without IF EXISTS: IF EXISTS does not stop
 *     it dropping a populated table. A DO block with a row-count guard is accepted.
 *   - a `CREATE POLICY "<name>"` with no earlier `DROP POLICY IF EXISTS "<name>"`
 *
 * Ratchet: files listed in LEGACY_FINDINGS already had findings when this check
 * was added. They are reported but do not fail the run. Any NEW finding in any
 * other file fails it. Remove a file from LEGACY_FINDINGS when you fix it.
 *
 * Fixture-free and read-only: it reads the repo's migrations folder only.
 * Run: npx tsx scripts/test-migrations-idempotent.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "..", "..", "migrations");

// Files with findings at the time this check was added. Reported, not gating.
const LEGACY_FINDINGS = new Set<string>([
  "001_config_tables.sql",
  "003_extended_config_tables.sql",
  "023_discount_tables_realtime.sql",
  "024_order_groups_realtime_and_read.sql",
  "037_contact_log.sql",
]);

type Finding = { file: string; line: number; message: string };

function scan(file: string, text: string): Finding[] {
  const out: Finding[] = [];
  const lines = text.split(/\r?\n/);
  let inDoBlock = false;
  const droppedPolicies = new Set<string>();
  lines.forEach((raw, idx) => {
    const line = raw.trim();
    const n = idx + 1;
    if (/DO\s+\$\$/i.test(line)) inDoBlock = true;
    if (/END\s+\$\$/i.test(line)) { inDoBlock = false; return; }
    if (line.startsWith("--")) return;
    const drop = line.match(/^DROP\s+POLICY\s+IF\s+EXISTS\s+"([^"]+)"/i);
    if (drop) droppedPolicies.add(drop[1]);
    if (!inDoBlock && /^DROP\s+TABLE\b/i.test(line)) {
      out.push({ file, line: n, message: "top-level DROP TABLE (IF EXISTS still drops a populated table)" });
    }
    const pol = line.match(/^CREATE\s+POLICY\s+"([^"]+)"/i);
    if (pol && !droppedPolicies.has(pol[1])) {
      out.push({ file, line: n, message: `CREATE POLICY "${pol[1]}" without a preceding DROP POLICY IF EXISTS` });
    }
  });
  return out;
}

const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
const all: Finding[] = [];
for (const f of files) all.push(...scan(f, readFileSync(join(dir, f), "utf8")));

const gating = all.filter((x) => !LEGACY_FINDINGS.has(x.file));
const legacy = all.filter((x) => LEGACY_FINDINGS.has(x.file));

for (const x of legacy) console.log(`legacy  ${x.file}:${x.line} ${x.message}`);
for (const x of gating) console.log(`FAIL    ${x.file}:${x.line} ${x.message}`);

if (gating.length > 0) {
  console.error(`${gating.length} non-idempotent statement(s) in new or fixed migrations`);
  process.exit(1);
}
console.log(`migrations-idempotent: ${files.length} file(s) checked, ${legacy.length} legacy finding(s) reported, 0 gating`);
