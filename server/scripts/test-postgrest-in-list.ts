/**
 * S-7 / SEC-9 (rebuild task 1-5): item ids in the order-draft orphan delete's
 * `not.in` filter are quoted and escaped, so no id can change the list.
 *
 *   npx tsx scripts/test-postgrest-in-list.ts
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { postgrestInList } from "../src/services/postgrestFilter.js";

let passed = 0, failed = 0;
const ok = (label: string, cond: boolean, detail = "") => { if (cond) passed++; else failed++; console.log(`  ${cond ? "✓" : "✗"} ${label}${detail ? ` (${detail})` : ""}`); };

/** PostgREST's reading of an in-list: comma-separated, a value in double quotes is literal with \" and \ escapes. */
function readAsPostgrest(list: string): string[] {
  if (!list.startsWith("(") || !list.endsWith(")")) throw new Error("not a list");
  const body = list.slice(1, -1), out: string[] = [];
  let i = 0;
  while (i < body.length) {
    if (body[i] === '"') {
      let v = ""; i++;
      while (i < body.length && body[i] !== '"') { if (body[i] === "\\") i++; v += body[i++]; }
      i++; out.push(v);
    } else { const j = body.indexOf(",", i); const end = j < 0 ? body.length : j; out.push(body.slice(i, end)); i = end; }
    if (body[i] === ",") i++;
  }
  return out;
}

const tricky = ["ZZ TEST HUB (A), 26", 'ZZ TEST 20" TYRE', String.raw`ZZ TEST BACK\SLASH`, "ends with " + String.fromCharCode(92),String.raw`\"both`, "plain", "a)b", "x,y,z", " spaced "];
const list = postgrestInList(tricky);
ok("every value comes back exactly, however many commas, brackets, quotes or backslashes it holds", JSON.stringify(readAsPostgrest(list)) === JSON.stringify(tricky), list);
ok("the old unescaped join did not (the bug)", JSON.stringify(readAsPostgrest(`(${tricky.join(",")})`)) !== JSON.stringify(tricky));
let threw = false; try { postgrestInList([]); } catch { threw = true; }
ok("an empty list is refused (NOT IN of nothing would delete everything)", threw);
const src = readFileSync(join(dirname(process.argv[1]), "..", "src", "services", "supabaseSync.ts"), "utf8");
ok("supabaseSync builds no in-list by joining raw values", !/"in",\s*`\(\$\{[^}]*join/.test(src) && /postgrestInList\(currentIds\)/.test(src));
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
