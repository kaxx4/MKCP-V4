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
/** A raw post, which writes only when the file also carries a write marker:
 *  tallyPost, or a hand-made `fetch(` / `http.request(` / `request(` to the port (third review). */
const RAW_POST = /(?<![\w$])(tallyPost|tallyPostWithRetry|fetch)\s*(?:\?\.\s*)?\(|\bhttps?\s*\.\s*(?:request|get)\s*\(|(?<![\w$.])request\s*\(/;
/** Every write verb (Import, and an Alter / Delete / Cancel / Create action), and the Import builders. */
const WRITE_MARK = /TALLYREQUEST>\s*Import|ACTION\s*=\s*\\?["'`]?\s*(Delete|Alter|Create|Cancel)\b|<ACTION>|\b(buildVoucherImportXml|buildLedgerXml|buildStockItemXml|buildUnitXml|buildGodownXml|buildBulkVoucher)\s*\(/;

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

/**
 * Statements that bind a name without calling it: static imports, re-exports
 * from another module, and `{ ... } = import(...)` / `require(...)`
 * destructuring. Read on the CODE view (strings blanked), so text inside a
 * string can neither create an alias nor hide one (third review, 5-Nov-2026).
 */
const IMPORT_STMT = /\bimport\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?(?:\{[^{}]*\}|\*\s*as\s+[\w$]+|[\w$]+)\s*from\s*["'`][^"'`\n]*["'`]/g;
const REEXPORT_STMT = /\bexport\s+(?:type\s+)?(?:\{([^{}]*)\}|\*(?:\s*as\s+[\w$]+)?)\s*from\s*["'`][^"'`\n]*["'`]/g;
const DESTRUCTURE_STMT = /\{([^{}]*)\}\s*=\s*(?:await\s+)?(?:import|require)\s*\(/g;

/** Local names a write or gate function is bound to (`import { safePush as send }`, `const { pushBulk: pb } = await import(...)` or `require(...)`). */
function aliases(code: string, names: string[]): string[] {
  const out: string[] = [];
  const add = (list: string, sep: RegExp) => {
    for (const part of list.split(",")) {
      const m = part.trim().replace(/^type\s+/, "").split(sep);
      if (m.length === 2 && names.includes(m[0].trim()) && /^[\w$]+$/.test(m[1].trim())) out.push(m[1].trim());
    }
  };
  for (const m of code.matchAll(/\bimport\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?\{([^{}]*)\}/g)) add(m[1], /\s+as\s+/);
  for (const m of code.matchAll(DESTRUCTURE_STMT)) add(m[1], /\s*:\s*/);
  return out;
}

/** Escape a name for use inside a RegExp source. */
const reName = (n: string) => n.replace(/\$/g, "\\$");

/** The module each gate must come from. A same-named function from anywhere else is not the gate. */
const GATE_MODULES: Record<string, RegExp> = {
  guardScriptWrites: /(^|\/)scriptWriteGuard(\.[jt]s)?$/,
  assertScriptWriteAllowed: /(^|\/)scriptWriteGuard(\.[jt]s)?$/,
  assertSandboxTarget: /(^|\/)guardrails\/sandbox(\.[jt]s)?$|^\.\/sandbox(\.[jt]s)?$/,
  installMock: /(^|\/)tallyMock(\.[jt]s)?$/,
};
/**
 * Local names bound to a real gate: `import { g as h } from "<gate module>"` or
 * `const { g: h } = await import("<gate module>")`. The binding is found on the
 * CODE view and the module path is read from the original source at the same
 * place (both views keep every offset), so a binding written inside a string
 * does not count (review of 5-Nov-2026).
 */
function boundGates(src: string, code: string): string[] {
  const out: string[] = [];
  const spec = (at: number) => { const q = src[at]; const end = src.indexOf(q, at + 1); return end < 0 ? "" : src.slice(at + 1, end); };
  const take = (list: string, sep: RegExp, from: string) => {
    for (const part of list.split(",")) {
      const bits = part.trim().replace(/^type\s+/, "").split(sep).map((x) => x.trim());
      const orig = bits[0], local = bits[1] ?? bits[0];
      if (GATE_MODULES[orig]?.test(from) && /^[\w$]+$/.test(local)) out.push(local);
    }
  };
  for (const m of code.matchAll(/\bimport\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?\{([^{}]*)\}\s*from\s*(?=["'`])/g)) take(m[1], /\s+as\s+/, spec(m.index! + m[0].length));
  for (const m of code.matchAll(/\{([^{}]*)\}\s*=\s*(?:await\s+)?(?:import|require)\s*\(\s*(?=["'`])/g)) take(m[1], /\s*:\s*/, spec(m.index! + m[0].length));
  return out;
}

/**
 * Names a lib file hands a write helper out under: `export { safePush as send } from`,
 * and `export const send = safePush`. Collected over every scanned file first,
 * then treated as write names everywhere (a name re-exported anywhere counts in
 * every file, which is stricter than following the import path).
 */
function reexportedWriters(src: string): string[] {
  const code = views(src).code;
  const out: string[] = [];
  for (const m of code.matchAll(REEXPORT_STMT)) {
    for (const part of (m[1] ?? "").split(",")) {
      const [from, to] = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/).map((x) => x?.trim());
      if (from && to && WRITE_NAMES.includes(from) && /^[\w$]+$/.test(to)) out.push(to);
    }
  }
  const W = WRITE_NAMES.map(reName).join("|");
  for (const m of code.matchAll(new RegExp(String.raw`\bexport\s+(?:const|let|var)\s+([\w$]+)\s*=\s*(?:${W})(?![\w$])`, "g"))) out.push(m[1]);
  return out;
}
/** Every source type a script can be written in. */
const SCAN_EXT = /\.(ts|mts|cts|tsx|js|mjs|cjs|jsx)$/;

/** Blank every match of `re` in `s` (same length, line breaks kept). */
const blankAll = (s: string, re: RegExp) => s.replace(re, (m) => m.replace(/[^\r\n]/g, " "));

type GateState = "not-a-writer" | "gated" | "ungated" | "gate-after-write";
/** Where the first write sits, and whether a gate call comes before it. */
function gateState(src: string, extraWrites: string[] = [], file: string = PLANT_FILE): GateState {
  const v = views(src);
  const s = v.code;
  /* The code with binding statements blanked: a name that is only imported,
     re-exported or destructured is not used yet. */
  const used = blankAll(blankAll(blankAll(s, IMPORT_STMT), REEXPORT_STMT), DESTRUCTURE_STMT);
  /* A write is ANY use of a write helper's name, not only `name(`: passed as a
     value (`rows.map(pushVoucherToTally)`), assigned (`const send = safePush`),
     `?.(`, `.call(` / `.apply(` / `.bind(`. Stricter: assigning before the
     gate counts as the first write. */
  const writeNames = [...new Set([...WRITE_NAMES, ...extraWrites, ...aliases(s, [...WRITE_NAMES, ...extraWrites])])];
  const WRITE_REF = new RegExp(String.raw`(?<![\w$])(${writeNames.map(reName).join("|")})(?![\w$])`);
  /* A gate is a CALL of the real gate: bound from its own module (boundGates),
     not a method on some object, not a declaration, and not a name the file
     declares itself (`function guardScriptWrites(){}`). `isSandbox()` is not a
     gate at all: it only reads the role, and a script can ignore its answer. */
  const gateNames = boundGates(src, s)
    .filter((n) => !new RegExp(String.raw`(?:\bfunction\s*\*?\s*|\b(?:const|let|var|class)\s+)${reName(n)}(?![\w$])`).test(s));
  const GATE = gateNames.length
    ? new RegExp(String.raw`(?<![\w$.])(?<!\bfunction\s*\*?\s*)(${gateNames.map(reName).join("|")})\s*(?:\?\.\s*)?\(`)
    : /(?!)/;
  /* `svc["safePush"](...)`: the name sits in a string, so it is looked for on
     the text view, inside brackets only. */
  const BRACKET_REF = new RegExp(String.raw`\[\s*(["'\x60])(${writeNames.map(reName).join("|")})\1\s*\]`);
  const refs = [used.search(WRITE_REF), v.text.search(BRACKET_REF)].filter((x) => x >= 0);
  const call = refs.length ? Math.min(...refs) : -1;
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
/** Where a planted source pretends to live, so its relative imports resolve like a real script's. */
const PLANT_FILE = join(serverRoot, "scripts", "plant.ts");
const PLANT_GUARDRAILS = join(serverRoot, "scripts", "guardrails", "plant.ts");
/** The real gate's import. A gate counts only when bound from scriptWriteGuard (review of 5-Nov-2026). */
const GI = `import { guardScriptWrites } from "../src/services/scriptWriteGuard.js";\n`;
ok("plant: a pushVoucherToTally with no gate is ungated", gateState(`const r = await pushVoucherToTally(U, co, p, m);`) === "ungated");
ok("plant: a pushBulk with no gate is ungated", gateState(`await pushBulk(U, co, "receipt", rows);`) === "ungated");
ok("plant: a createLedger / deleteLedger with no gate is ungated", gateState(`await createLedger(U, co, l); await deleteLedger(U, co, n);`) === "ungated");
ok("plant: createStockItem / createUnit / createGodown with no gate are ungated",
  ["createStockItem", "createUnit", "createGodown"].every((f) => gateState(`await ${f}(U, co, x);`) === "ungated"));
ok("plant: a raw tallyPost of an ACTION=\"Delete\" with no gate is ungated", gateState(`const x = '<VOUCHER ACTION="Delete">'; await tallyPost(U, x);`) === "ungated");
ok("plant: a raw tallyPost of an Import envelope is ungated", gateState("const x = `<TALLYREQUEST>Import</TALLYREQUEST>`; await tallyPost(U, x);") === "ungated");
ok("plant: a raw tallyPost of buildVoucherImportXml is ungated", gateState(`await tallyPost(U, buildVoucherImportXml(co, p));`) === "ungated");
ok("plant: a gate AFTER the first write fails", gateState(GI + `await pushVoucherToTally(U, co, p, m);\nguardScriptWrites("x");`) === "gate-after-write");
ok("plant: a gate only in a comment does not count", gateState(`// guardScriptWrites("x")\nawait pushBulk(U, co, "receipt", rows);`) === "ungated");
ok("plant: a gate before the write passes", gateState(GI + `guardScriptWrites("x");\nawait pushVoucherToTally(U, co, p, m);`) === "gated");
// Hardened 5-Nov-2026 after the 0-1 review.
ok("plant: a pushBankPlan with no gate is ungated", gateState(`const res = await pushBankPlan(U, co, plan);`) === "ungated");
ok("plant: a startPushAgent with no gate is ungated", gateState(`startPushAgent({ tallyUrl: TALLY });`) === "ungated");
ok("plant: a drainNow with no gate is ungated", gateState(`drainNow();`) === "ungated");
ok("plant: deleteStockItem / deleteGodown with no gate are ungated",
  ["deleteStockItem", "deleteGodown"].every((f) => gateState(`await ${f}(U, co, x);`) === "ungated"));
ok("plant: a gate inside a string literal does not count", gateState(`const s = "guardScriptWrites('x')";\nawait safePush(U, co, p);`) === "ungated");
ok("plant: a gate inside template text does not count", gateState("const s = `guardScriptWrites(\"x\")`;\nawait safePush(U, co, p);") === "ungated");
ok("plant: a comment right after a quote is still a comment", gateState(`log("a")// guardScriptWrites("x")\nawait safePush(U, co, p);`) === "ungated");
ok("plant: a URL in a string is not a comment", gateState(GI + `const u = "http://localhost:9000"; guardScriptWrites("x");\nawait safePush(u, co, p);`) === "gated");
ok("plant: a regex with slashes is not a comment", gateState(GI + `const re = /^\\/\\//; guardScriptWrites("x");\nawait safePush(U, co, p);`) === "gated");
ok("plant: a write inside a template expression counts", gateState("const s = `sent ${await safePush(U, co, p)}`;") === "ungated");
ok("plant: an aliased import still counts as a write", gateState(`import { safePush as send } from "../src/services/safePush.js";\nawait send(U, co, p);`) === "ungated");
ok("plant: a renamed destructured dynamic import still counts", gateState(`const { pushBulk: pb } = await import("../src/services/bulkEntry.js");\nawait pb(U, co, "receipt", rows);`) === "ungated");
ok("plant: an aliased gate before the write passes", gateState(`import { guardScriptWrites as gate } from "../src/services/scriptWriteGuard.js";\ngate("x");\nawait safePush(U, co, p);`) === "gated");
ok("plant: an import line naming a writer is not itself a write", gateState(`import { safePush } from "../src/services/safePush.js";`) === "not-a-writer");
ok("plant: a read-only script is not a writer", gateState(`await tallyPost(U, buildCollectionXml(def, co));`) === "not-a-writer");
// Third review, 5-Nov-2026: a write that is not a plain `name(` call, and gates that are not the real gate.
ok("plant: a write helper passed as a value is a write", gateState(`await Promise.all(rows.map(pushVoucherToTally));`) === "ungated");
ok("plant: a write helper assigned to a local is a write", gateState(`const send = safePush;\nawait send(U, co, p);`) === "ungated");
ok("plant: an optional call ?.( is a write", gateState(`await safePush?.(U, co, p);`) === "ungated");
ok("plant: .call( .apply( .bind( are writes",
  [`await safePush.call(null, U, co, p);`, `await safePush.apply(null, [U, co, p]);`, `const f = safePush.bind(null, U);\nawait f(co, p);`]
    .every((s) => gateState(s) === "ungated"));
ok("plant: a write helper re-exported under a new name in a lib file is a write",
  gateState(`import { send } from "./lib/push.js";\nawait send(U, co, p);`,
    reexportedWriters(`export { safePush as send } from "../../src/services/safePush.js";`)) === "ungated");
ok("plant: a renamed require destructuring is a write", gateState(`const { safePush: s } = require("../src/services/safePush.js");\nawait s(U, co, p);`) === "ungated");
ok("plant: a destructured import before the gate is not itself a write",
  gateState(GI + `const { pushBulk: pb } = await import("../src/services/bulkEntry.js");\nguardScriptWrites("x");\nawait pb(U, co, "receipt", rows);`) === "gated");
ok("plant: a helper passed as a value after the gate passes", gateState(GI + `guardScriptWrites("x");\nawait Promise.all(rows.map(pushVoucherToTally));`) === "gated");
ok("plant: a raw fetch of a Delete to the Tally port is ungated",
  gateState(`const x = '<VOUCHER ACTION="Delete">';\nawait fetch("http://localhost:9000", { method: "POST", body: x });`) === "ungated");
ok("plant: a raw http.request of an Import envelope is ungated",
  gateState("const x = `<TALLYREQUEST>Import</TALLYREQUEST>`;\nconst req = http.request({ port: 9000, method: \"POST\" }); req.end(x);") === "ungated");
ok("plant: .cjs .cts .tsx .jsx files are scanned", ["a.cjs", "a.cts", "a.tsx", "a.jsx", "a.ts", "a.mjs"].every((f) => SCAN_EXT.test(f)));
ok("plant: a local function named like the gate is not a gate", gateState(`function guardScriptWrites() {}\nguardScriptWrites("x");\nawait safePush(U, co, p);`) === "ungated");
ok("plant: a local const named like the gate is not a gate", gateState(`const guardScriptWrites = () => {};\nguardScriptWrites("x");\nawait safePush(U, co, p);`) === "ungated");
ok("plant: a method x.isSandbox() is not a gate", gateState(`if (cfg.isSandbox()) log("ok");\nawait safePush(U, co, p);`) === "ungated");
// Review of the third-review fixes, 5-Nov-2026.
ok("plant: an alias whose name starts with $ still counts as a write",
  gateState(`import { safePush as $send } from "../src/services/safePush.js";\nawait $send(U, co, p);`) === "ungated");
ok("plant: a bare if (isSandbox()) is not a gate", gateState(`import { isSandbox } from "../src/services/tallyRole.js";\nif (isSandbox()) log("ok");\nawait safePush(U, co, p);`) === "ungated");
ok("plant: a gate imported from some other module is not a gate",
  gateState(`import { guardScriptWrites } from "./lib/noop.js";\nguardScriptWrites("x");\nawait safePush(U, co, p);`) === "ungated");
ok("plant: a gate never imported at all is not a gate", gateState(`guardScriptWrites("x");\nawait safePush(U, co, p);`) === "ungated");
ok("plant: a gate from the real module, by dynamic import, passes",
  gateState(`const { guardScriptWrites: g } = await import("../src/services/scriptWriteGuard.js");\ng("x");\nawait safePush(U, co, p);`) === "gated");
ok("plant: a gate destructured from its module inside a function body passes",
  gateState(`export async function run() {\n  const { installMock } = await import("../../src/services/tallyMock.js");\n  const { safePush: s } = await import("../../src/services/safePush.js");\n  installMock(t);\n  await s(U, co, p);\n}`, [], PLANT_GUARDRAILS) === "gated");
ok("plant: a same-named local no-op in a scriptWriteGuard file of its own is not the gate",
  gateState(`import { guardScriptWrites } from "./lib/scriptWriteGuard.js";\nguardScriptWrites("x");\nawait safePush(U, co, p);`) === "ungated");
ok("plant: the real module named from the wrong folder depth is not the gate",
  gateState(`import { guardScriptWrites } from "../../src/services/scriptWriteGuard.js";\nguardScriptWrites("x");\nawait safePush(U, co, p);`) === "ungated");
ok("plant: the real module from a guardrails/ file passes",
  gateState(`import { guardScriptWrites } from "../../src/services/scriptWriteGuard.js";\nguardScriptWrites("x");\nawait safePush(U, co, p);`, [], PLANT_GUARDRAILS) === "gated");
ok("plant: a sandbox.js that is not guardrails/sandbox is not the gate",
  gateState(`import { assertSandboxTarget } from "./sandbox.js";\nassertSandboxTarget();\nawait safePush(U, co, p);`) === "ungated");
ok("plant: m[\"safePush\"](...) is a write", gateState(`await svc["safePush"](U, co, p);`) === "ungated");
ok("plant: an alias written inside a string is not an alias",
  gateState(`const s = "import { guardScriptWrites as gate } from 'x'";\ngate("x");\nawait safePush(U, co, p);`) === "ungated");

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (n === "node_modules" || n === "fixtures") continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out); else if (SCAN_EXT.test(p)) out.push(p);
  }
  return out;
}
const ungated: string[] = [];
const late: string[] = [];
let writers = 0;
const files = [join(serverRoot, "scripts"), join(repoRoot, "scripts")].flatMap((dir) => walk(dir));
/* First pass: every name a lib file re-exports a write helper under. */
const reexported = [...new Set(files.flatMap((f) => reexportedWriters(readFileSync(f, "utf8"))))];
if (reexported.length) console.log(`  re-exported write helpers followed: ${reexported.join(", ")}`);
{
  for (const f of files) {
    const rel = relative(repoRoot, f).split(sep).join("/");
    if (EXEMPT[rel]) continue;
    const st = gateState(readFileSync(f, "utf8"), reexported);
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
