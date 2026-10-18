/**
 * Source-scanning guard: the company's Tally name is written in ONE file,
 * src/config/company.ts. A hard-coded "M.K.CYCLES ..." string anywhere else in
 * src/ or scripts/ is a copy that goes stale at the next financial year (the
 * 1-April rename) or on a duplicate company, and a stale copy writes to the
 * wrong books.
 *
 * Comments are ignored. Three test files assert behaviour ON specific company
 * names (suffix stripping, a guid fallback, a report request) and are allowed
 * to spell them out.
 *
 *   npx tsx scripts/test-company-literal-guard.ts
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWED = new Set([
  "src/config/company.ts",
  "scripts/test-company-literal-guard.ts",
  "scripts/test-mirror-panel-edit-log.ts",   // tests the FY-suffix stripping on literal names
  "scripts/test-phantom-master-guard.ts",    // a literal guid fallback string
  "scripts/test-tally-request.ts",           // a literal report request
]);
const LITERAL = /["'`]M\.K\.CYCLES/;

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (n === "node_modules" || n === "dist" || n === "data" || n === "fixtures") continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out); else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

const NL = String.fromCharCode(10);
const hits: string[] = [];
for (const dir of ["src", "scripts"]) {
  for (const f of walk(join(root, dir))) {
    const rel = relative(root, f).split(sep).join("/");
    if (ALLOWED.has(rel)) continue;
    let inBlock = false;
    readFileSync(f, "utf8").split(NL).forEach((line, i) => {
      const t = line.trim();
      if (inBlock) { if (t.includes("*/")) inBlock = false; return; }
      if (t.startsWith("/*")) { if (!t.includes("*/")) inBlock = true; return; }
      if (t.startsWith("//") || t.startsWith("*")) return;
      if (LITERAL.test(line)) hits.push(`${rel}:${i + 1}  ${t.slice(0, 100)}`);
    });
  }
}

if (hits.length) {
  console.error(`\n  \x1b[31m✗\x1b[0m the company-name literal is hard-coded outside src/config/company.ts:`);
  for (const h of hits) console.error(`      ${h}`);
  console.error(`    Import DEFAULT_TALLY_COMPANY / tallyCompany() from src/config/company.ts instead.\n`);
  process.exit(1);
}
console.log(`\n  \x1b[32m✓\x1b[0m no hard-coded company-name literal outside src/config/company.ts\n`);
