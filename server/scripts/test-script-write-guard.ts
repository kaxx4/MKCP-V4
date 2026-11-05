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
 *   npx tsx scripts/test-script-write-guard.ts   (scans server/scripts and the repo-root scripts)
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
// Widened 5-Nov-2026 (rebuild task 0-1, S-11). The first version missed five
// writers that write through a service call instead of a raw Import envelope
// (pushVoucherToTally, pushBulk, the master builders), never looked at the
// repo-root scripts/ folder, and its ACTION= pattern needed a literal "?" so it
// matched nothing. A file now counts as gated only when the gate call comes
// BEFORE its first write in the source, so a gate added after the push fails.
const serverRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(serverRoot, "..");
/** Scripts that post but never WRITE to a real Tally, each with the reason. Keys are repo-relative. */
const EXEMPT: Record<string, string> = {
  "server/scripts/test-xml-hardening.ts": "posts only to a throwaway local fake socket server to test the wire decoding",
  "server/scripts/test-script-write-guard.ts": "this file",
  "server/scripts/test-practice-company.ts": "calls safePush against a dead address to prove the practice-company refusal fires before any byte is sent",
  "server/scripts/guardrails/static.ts": "calls pushVoucherToTally only against a dead address (127.0.0.1:1) to prove it throws on missing masters before any byte is sent",
};
/** A call that writes by itself: every service entry point that sends an Import. */
const WRITE_CALL = /\b(safePush|pushVoucherToTally|pushBulk|createLedger|deleteLedger|createStockItem|createUnit|deleteUnit|createGodown)\s*\(/;
/** A raw post, which writes only when the file also carries a write marker. */
const RAW_POST = /\b(tallyPost|tallyPostWithRetry)\s*\(/;
/** Every write verb (Import, and an Alter / Delete / Cancel / Create action), and the Import builders. */
const WRITE_MARK = /TALLYREQUEST>\s*Import|ACTION\s*=\s*\\?["'`]?\s*(Delete|Alter|Create|Cancel)\b|<ACTION>|\b(buildVoucherImportXml|buildLedgerXml|buildStockItemXml|buildUnitXml|buildGodownXml|buildBulkVoucher)\s*\(/;
const GATE = /\bguardScriptWrites\s*\(|\bassertScriptWriteAllowed\s*\(|\bisSandbox\s*\(\s*\)|\bassertSandboxTarget\s*\(|\binstallMock\s*\(/;

/** Blank out comments and import lines, keeping offsets and line numbers. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .split("\n")
    .map((l) => (/^\s*import\b/.test(l) ? "" : l.replace(/(^|[^:"'`\\])\/\/.*$/, "$1")))
    .join("\n");
}

type GateState = "not-a-writer" | "gated" | "ungated" | "gate-after-write";
/** Where the first write sits, and whether a gate call comes before it. */
function gateState(src: string): GateState {
  const s = code(src);
  const call = s.search(WRITE_CALL);
  const post = s.search(RAW_POST);
  const mark = s.search(WRITE_MARK);
  let first = call;
  if (post >= 0 && mark >= 0) {
    const raw = Math.max(post, mark);
    first = first < 0 ? raw : Math.min(first, raw);
  }
  if (first < 0) return "not-a-writer";
  const gate = s.search(GATE);
  if (gate < 0) return "ungated";
  return gate < first ? "gated" : "gate-after-write";
}

// The classifier itself, on planted sources (so a broken pattern fails here, not silently).
ok("plant: a pushVoucherToTally with no gate is ungated", gateState(`const r = await pushVoucherToTally(U, co, p, m);`) === "ungated");
ok("plant: a pushBulk with no gate is ungated", gateState(`await pushBulk(U, co, "receipt", rows);`) === "ungated");
ok("plant: a createLedger / deleteLedger with no gate is ungated", gateState(`await createLedger(U, co, l); await deleteLedger(U, co, n);`) === "ungated");
ok("plant: createStockItem / createUnit / createGodown with no gate are ungated",
  ["createStockItem", "createUnit", "createGodown"].every((f) => gateState(`await ${f}(U, co, x);`) === "ungated"));
ok("plant: a raw tallyPost of an ACTION=\"Delete\" with no gate is ungated", gateState(`const x = '<VOUCHER ACTION="Delete">'; await tallyPost(U, x);`) === "ungated");
ok("plant: a raw tallyPost of an Import envelope is ungated", gateState("const x = `<TALLYREQUEST>Import</TALLYREQUEST>`; await tallyPost(U, x);") === "ungated");
ok("plant: a raw tallyPost of buildVoucherImportXml is ungated", gateState(`await tallyPost(U, buildVoucherImportXml(co, p));`) === "ungated");
ok("plant: a gate AFTER the first write fails", gateState(`await pushVoucherToTally(U, co, p, m);\nguardScriptWrites("x");`) === "gate-after-write");
ok("plant: a gate only in a comment does not count", gateState(`// guardScriptWrites("x")\nawait pushBulk(U, co, "receipt", rows);`) === "ungated");
ok("plant: a gate before the write passes", gateState(`guardScriptWrites("x");\nawait pushVoucherToTally(U, co, p, m);`) === "gated");
ok("plant: a read-only script is not a writer", gateState(`await tallyPost(U, buildCollectionXml(def, co));`) === "not-a-writer");

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (n === "node_modules" || n === "fixtures") continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out); else if (/\.(ts|mts|mjs|js)$/.test(p)) out.push(p);
  }
  return out;
}
const ungated: string[] = [];
const late: string[] = [];
let writers = 0;
for (const dir of [join(serverRoot, "scripts"), join(repoRoot, "scripts")]) {
  for (const f of walk(dir)) {
    const rel = relative(repoRoot, f).split(sep).join("/");
    if (EXEMPT[rel]) continue;
    const st = gateState(readFileSync(f, "utf8"));
    if (st === "not-a-writer") continue;
    writers++;
    if (st === "ungated") ungated.push(rel);
    if (st === "gate-after-write") late.push(rel);
  }
}
ok(`all ${writers} scripts that post a write are gated (server/scripts and root scripts)`, ungated.length === 0, ungated.length ? `ungated: ${ungated.join(", ")}` : "");
ok("every gate runs before the script's first write", late.length === 0, late.length ? `gate after write: ${late.join(", ")}` : "");
ok("the gate scan found writers at all (not vacuous)", writers >= 40, `${writers} found`);

if (failures) { console.error(`\n  ${failures} check(s) failed\n`); process.exit(1); }
console.log("\n  all checks passed\n");
