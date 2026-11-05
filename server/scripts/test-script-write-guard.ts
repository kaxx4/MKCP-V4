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
/**
 * Calls that write by themselves: every service entry point that sends an
 * Import, or starts something that does. Hardened 5-Nov-2026 (0-1 review):
 * pushBankPlan (bankToReceipts -> safePush), startPushAgent / drainNow (the
 * queue drain posts every claimed row), deleteStockItem / deleteGodown.
 */
const WRITE_NAMES = ["safePush", "pushVoucherToTally", "pushBulk", "pushBankPlan", "startPushAgent", "drainNow",
  "createLedger", "deleteLedger", "createStockItem", "deleteStockItem", "createUnit", "deleteUnit", "createGodown", "deleteGodown"];
const GATE_NAMES = ["guardScriptWrites", "assertScriptWriteAllowed", "assertSandboxTarget", "installMock"];
/** A raw post, which writes only when the file also carries a write marker. */
const RAW_POST = /\b(tallyPost|tallyPostWithRetry)\s*\(/;
/** Every write verb (Import, and an Alter / Delete / Cancel / Create action), and the Import builders. */
const WRITE_MARK = /TALLYREQUEST>\s*Import|ACTION\s*=\s*\\?["'`]?\s*(Delete|Alter|Create|Cancel)\b|<ACTION>|\b(buildVoucherImportXml|buildLedgerXml|buildStockItemXml|buildUnitXml|buildGodownXml|buildBulkVoucher)\s*\(/;
const callOf = (names: string[]) => new RegExp(`(?<![\\w$])(${names.map((n) => n.replace(/\$/g, "\\$")).join("|")})\\s*\\(`);

/**
 * Two views of a source, same length and line breaks as the original:
 *  - `code`: comments, string and template text and regex bodies blanked, so a
 *    gate or a write named inside a string or comment does not count;
 *  - `text`: only comments blanked, so a write verb inside an XML string is seen.
 * A small tokenizer, not a regex per line: the old line regex left a `//`
 * comment in place whenever a quote stood right before it.
 */
function views(src: string): { code: string; text: string } {
  const code = src.split(""), text = src.split("");
  const n = src.length;
  const blank = (a: string[], i: number) => { if (a[i] !== "\n" && a[i] !== "\r") a[i] = " "; };
  const both = (i: number) => { blank(code, i); blank(text, i); };
  const tpl: number[] = [];   // brace depth at each open `${`
  let depth = 0, prev = "", word = "";
  const REGEX_AFTER = "(,=:[!&|?{};+-*%<>~^";
  const REGEX_WORDS = new Set(["return", "typeof", "case", "do", "else", "in", "of", "yield", "await", "void", "delete", "throw", "new"]);
  /** Scan template text from i (just inside a backtick or after a closing `}`); returns the index after it. */
  const template = (i: number): number => {
    while (i < n) {
      const c = src[i];
      if (c === "\\") { blank(code, i); blank(code, i + 1); i += 2; continue; }
      if (c === "`") return i + 1;
      if (c === "$" && src[i + 1] === "{") { tpl.push(depth); depth++; return i + 2; }
      blank(code, i); i++;
    }
    return i;
  };
  let i = 0;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === "/" && d === "/") { while (i < n && src[i] !== "\n") both(i++); continue; }
    if (c === "/" && d === "*") { const e = src.indexOf("*/", i + 2); const end = e < 0 ? n : e + 2; while (i < end) both(i++); continue; }
    if (c === '"' || c === "'") {
      i++;
      while (i < n && src[i] !== c && src[i] !== "\n") { if (src[i] === "\\") blank(code, i++); blank(code, i++); }
      i++; prev = c; word = ""; continue;
    }
    if (c === "`") { i = template(i + 1); prev = "`"; word = ""; continue; }
    if (c === "/" && (prev === "" || REGEX_AFTER.includes(prev) || REGEX_WORDS.has(word))) {
      i++; let cls = false;
      while (i < n && src[i] !== "\n") {
        const r = src[i];
        if (r === "\\") { blank(code, i++); blank(code, i++); continue; }
        if (r === "[") cls = true; else if (r === "]") cls = false; else if (r === "/" && !cls) break;
        blank(code, i++);
      }
      i++; prev = "/r"; word = ""; continue;
    }
    if (c === "{") depth++;
    if (c === "}") {
      if (tpl.length && depth - 1 === tpl[tpl.length - 1]) { tpl.pop(); depth--; i = template(i + 1); prev = "`"; word = ""; continue; }
      depth--;
    }
    if (/[\w$]/.test(c)) { word = /[\w$]/.test(prev) ? word + c : c; prev = c; }
    else if (!/\s/.test(c)) { prev = c; word = ""; }
    i++;
  }
  return { code: code.join(""), text: text.join("") };
}

/** Local names a write or gate function is imported under (`import { safePush as send }`, `const { pushBulk: pb } = await import(...)`). */
function aliases(text: string, names: string[]): string[] {
  const out: string[] = [];
  const add = (list: string, sep: RegExp) => {
    for (const part of list.split(",")) {
      const m = part.trim().replace(/^type\s+/, "").split(sep);
      if (m.length === 2 && names.includes(m[0].trim()) && /^[\w$]+$/.test(m[1].trim())) out.push(m[1].trim());
    }
  };
  for (const m of text.matchAll(/\bimport\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?\{([^}]*)\}/g)) add(m[1], /\s+as\s+/);
  for (const m of text.matchAll(/\{([^}]*)\}\s*=\s*(?:await\s+)?import\s*\(/g)) add(m[1], /\s*:\s*/);
  return out;
}

type GateState = "not-a-writer" | "gated" | "ungated" | "gate-after-write";
/** Where the first write sits, and whether a gate call comes before it. */
function gateState(src: string): GateState {
  const v = views(src);
  const s = v.code;
  const WRITE_CALL = callOf([...WRITE_NAMES, ...aliases(v.text, WRITE_NAMES)]);
  const GATE = new RegExp(`${callOf([...GATE_NAMES, ...aliases(v.text, GATE_NAMES)]).source}|(?<![\\w$])isSandbox\\s*\\(\\s*\\)`);
  const call = s.search(WRITE_CALL);
  const post = s.search(RAW_POST);
  const mark = v.text.search(WRITE_MARK);
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
// Hardened 5-Nov-2026 after the 0-1 review.
ok("plant: a pushBankPlan with no gate is ungated", gateState(`const res = await pushBankPlan(U, co, plan);`) === "ungated");
ok("plant: a startPushAgent with no gate is ungated", gateState(`startPushAgent({ tallyUrl: TALLY });`) === "ungated");
ok("plant: a drainNow with no gate is ungated", gateState(`drainNow();`) === "ungated");
ok("plant: deleteStockItem / deleteGodown with no gate are ungated",
  ["deleteStockItem", "deleteGodown"].every((f) => gateState(`await ${f}(U, co, x);`) === "ungated"));
ok("plant: a gate inside a string literal does not count", gateState(`const s = "guardScriptWrites('x')";\nawait safePush(U, co, p);`) === "ungated");
ok("plant: a gate inside template text does not count", gateState("const s = `guardScriptWrites(\"x\")`;\nawait safePush(U, co, p);") === "ungated");
ok("plant: a comment right after a quote is still a comment", gateState(`log("a")// guardScriptWrites("x")\nawait safePush(U, co, p);`) === "ungated");
ok("plant: a URL in a string is not a comment", gateState(`const u = "http://localhost:9000"; guardScriptWrites("x");\nawait safePush(u, co, p);`) === "gated");
ok("plant: a regex with slashes is not a comment", gateState(`const re = /^\\/\\//; guardScriptWrites("x");\nawait safePush(U, co, p);`) === "gated");
ok("plant: a write inside a template expression counts", gateState("const s = `sent ${await safePush(U, co, p)}`;") === "ungated");
ok("plant: an aliased import still counts as a write", gateState(`import { safePush as send } from "../src/services/safePush.js";\nawait send(U, co, p);`) === "ungated");
ok("plant: a renamed destructured dynamic import still counts", gateState(`const { pushBulk: pb } = await import("../src/services/bulkEntry.js");\nawait pb(U, co, "receipt", rows);`) === "ungated");
ok("plant: an aliased gate before the write passes", gateState(`import { guardScriptWrites as gate } from "../src/services/scriptWriteGuard.js";\ngate("x");\nawait safePush(U, co, p);`) === "gated");
ok("plant: an import line naming a writer is not itself a write", gateState(`import { safePush } from "../src/services/safePush.js";`) === "not-a-writer");
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
