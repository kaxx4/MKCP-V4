/**
 * #104 — every operator script that writes to Tally goes through the write gate.
 *
 * Two parts, both offline:
 *   1. the gate's verdict (src/services/scriptWriteGuard.ts): refused on the
 *      default (primary) role, refused for a non-local Tally, allowed for a
 *      sandbox on localhost, allowed when a mock transport is installed.
 *   2. a SOURCE SCAN: any file under scripts/ that calls tallyPost / safePush
 *      AND carries a write marker (an Import envelope, an ACTION= Alter /
 *      Delete / Create / Cancel, or a safePush push) must reference one of the
 *      gates. A new write script with no gate fails here.
 *
 *   npx tsx scripts/test-script-write-guard.ts
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { scriptWriteVerdict, assertScriptWriteAllowed } from "../src/services/scriptWriteGuard.js";
import { tallyRole } from "../src/services/tallyRole.js";

let failures = 0;
function ok(name: string, pass: boolean, detail = ""): void {
  console.log(`  ${pass ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${name}${detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}

// ── 1. the verdict ─────────────────────────────────────────────────────────
ok("default (primary) role refuses", !scriptWriteVerdict({}, false).ok);
ok("explicit primary refuses", !scriptWriteVerdict({ MKCP_TALLY_ROLE: "primary", TALLY_URL: "http://localhost:9000" }, false).ok);
ok("sandbox on localhost allows", scriptWriteVerdict({ MKCP_TALLY_ROLE: "sandbox", TALLY_URL: "http://localhost:9000" }, false).ok);
ok("sandbox, URL unset (default localhost) allows", scriptWriteVerdict({ MKCP_TALLY_ROLE: " SANDBOX " }, false).ok);
ok("sandbox on 127.0.0.1 allows", scriptWriteVerdict({ MKCP_TALLY_ROLE: "sandbox", TALLY_URL: "http://127.0.0.1:9000/" }, false).ok);
ok("sandbox on a LAN address refuses", !scriptWriteVerdict({ MKCP_TALLY_ROLE: "sandbox", TALLY_URL: "http://192.168.1.20:9000" }, false).ok);
ok("sandbox on a lookalike host refuses", !scriptWriteVerdict({ MKCP_TALLY_ROLE: "sandbox", TALLY_URL: "http://localhost.evil.test:9000" }, false).ok);
ok("a mock transport allows (nothing leaves the process)", scriptWriteVerdict({}, true).ok);
let threw = false; try { assertScriptWriteAllowed("t", {}); } catch { threw = true; }
ok("assertScriptWriteAllowed throws when refused", threw || tallyRole() === "sandbox" /* mock not installed here */ );
ok("the role default is unchanged", (() => { const k = process.env.MKCP_TALLY_ROLE; delete process.env.MKCP_TALLY_ROLE; const r = tallyRole(); if (k !== undefined) process.env.MKCP_TALLY_ROLE = k; return r === "primary"; })());

// ── 2. the source scan ─────────────────────────────────────────────────────
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
/** Scripts that post but never WRITE to a real Tally, each with the reason. */
const EXEMPT: Record<string, string> = {
  "scripts/test-xml-hardening.ts": "posts only to a throwaway local fake socket server to test the wire decoding",
  "scripts/test-script-write-guard.ts": "this file",
};
const POSTS = /\b(tallyPost|tallyPostWithRetry|safePush)\s*\(/;
const WRITE = /TALLYREQUEST>\s*Import|ACTION=\?["']?(Delete|Alter|Create|Cancel)|<ACTION>|\bsafePush\s*\(/;
const GATED = /guardScriptWrites\(|assertScriptWriteAllowed\(|\bisSandbox\(\)|assertSandboxTarget\(|\binstallMock\(/;

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (n === "node_modules" || n === "fixtures") continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out); else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}
const ungated: string[] = [];
let writers = 0;
for (const f of walk(join(root, "scripts"))) {
  const rel = relative(root, f).split(sep).join("/");
  if (EXEMPT[rel]) continue;
  const src = readFileSync(f, "utf8");
  if (!POSTS.test(src) || !WRITE.test(src)) continue;
  writers++;
  if (!GATED.test(src)) ungated.push(rel);
}
ok(`all ${writers} scripts that post a write are gated`, ungated.length === 0, ungated.length ? `ungated: ${ungated.join(", ")}` : "");
ok("the gate scan found writers at all (not vacuous)", writers >= 40, `${writers} found`);

if (failures) { console.error(`\n  ${failures} check(s) failed\n`); process.exit(1); }
console.log("\n  all checks passed\n");
