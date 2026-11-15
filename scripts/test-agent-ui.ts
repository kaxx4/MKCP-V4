/**
 * Offline gate for the agent window's design and wording (agent-ui lane). It reads the renderer's source under src/ (never runs it) and fails on
 * anything the blue design language forbids, then checks the plain-English functions for the office computer card.
 *
 *   npx tsx scripts/test-agent-ui.ts
 *
 * Rules (each one a rule of the web app's design language, or of the owner's wording rule):
 *   no ellipsis (CSS cut-off, the `truncate` class, or the character or three dots in text); no em dash in anything shown; no emoji or pictograph in
 *   anything shown (LogsPanel may MATCH the server's markers, it never draws them); no gradient, glow, blur or heavy shadow; no bold weight class;
 *   no type below 12 px; no uppercase labels; no pulsing; no see-through colour (slash opacity); no literal colour outside styles/tokens.css and
 *   tailwind.config.js (which only names tokens); no bundled-font fetch from the network.
 * Comments may say why, so comments are ignored.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  plainPreflightLine, plainClaimNote, plainMirrorNote, plainStop, pinSentence, registeredSentence, officeFact, claimFact, mirrorRunFact, whenText, primaryIsOn,
  type PrimarySummaryLike,
} from "../src/status/primaryFacts";

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? `: ${detail}` : ""}`); }
};

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "src");
const ROOT = join(HERE, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!["node_modules", "__tests__", "data", "engine", "parser", "db", "store", "services", "hooks", "utils", "types", "api", "config"].includes(e.name)) walk(p, out); }
    else if (/\.(tsx|ts|css)$/.test(e.name)) out.push(p);
  }
  return out;
}

/** The text with comments blanked, line breaks kept. */
function code(text: string, css: boolean): string {
  let s = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  if (!css) s = s.replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, a) => a + " ".repeat(m.length - a.length));
  return s;
}

const files = walk(SRC);
const find = (re: RegExp, only?: (f: string) => boolean): string[] => {
  const hits: string[] = [];
  for (const f of files) {
    if (only && !only(f)) continue;
    const css = f.endsWith(".css");
    code(readFileSync(f, "utf8"), css).split("\n").forEach((l, i) => { if (re.test(l)) hits.push(`${relative(ROOT, f)}:${i + 1}: ${l.trim().slice(0, 100)}`); });
  }
  return hits;
};
const none = (label: string, re: RegExp, only?: (f: string) => boolean) => { const h = find(re, only); ok(label, h.length === 0, h.slice(0, 4).join(" | ")); };
const notTokens = (f: string) => !f.endsWith("tokens.css");
const notLogs = (f: string) => !f.endsWith("LogsPanel.tsx");

console.log("\n  the design rules, read from the source");
none("nothing is cut short with dots: no ellipsis in CSS", /text-overflow\s*:\s*ellipsis|line-clamp/i);
none("no truncate class", /\btruncate\b|\btext-ellipsis\b|\bline-clamp-\d/);
none("no ellipsis character or three dots in text (a code spread is not text)", /…|[A-Za-z0-9.!?,]\.\.\.(?![A-Za-z_$({\[])|["'`>]\.\.\.["'`<]/)
none("no em dash in anything shown", /—/);
none("no emoji or pictograph drawn", /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B50}\u{2705}\u{274C}]/u, notLogs);
none("no gradient", /gradient|\bfrom-\w|\bvia-\w|\bto-\w+-\d/);
none("no glow, blur or heavy shadow", /backdrop-blur|\bblur-|drop-shadow|\bshadow-(lg|xl|2xl|inner)|\bglow\b|box-shadow:[^;]*\d+px \d+px [1-9]\d+px/i, notTokens);
none("no bold weight class", /\bfont-(bold|semibold|extrabold|black)\b/);
none("no type below 12 px", /\btext-\[(\d|1[01])(\.\d+)?px\]|font-size:\s*(\d|1[01])px/);
none("no uppercase labels", /\buppercase\b|text-transform:\s*uppercase/);
none("nothing pulses", /animate-pulse|animate-ping|animate-bounce/);
none("no see-through colour (every tint is its own token)", /\b(bg|text|border|ring)-[a-z]+(-\d+)?\/(\d+|\[[\d.]+\])\b/);
none("no literal colour outside the tokens", /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/, (f) => notTokens(f) && !f.endsWith("LogsPanel.tsx"));
none("no off-scale spacing class (half steps)", /\b(p[xytblr]?|m[xytblr]?|gap(-[xy])?|space-[xy])-\d+\.5\b/);
none("no network font fetch", /fonts\.googleapis|fonts\.gstatic/);
ok("the stylesheet that remains in index.html fetches nothing", !/googleapis|gstatic|<link[^>]+stylesheet/.test(readFileSync(join(ROOT, "index.html"), "utf8")));
ok("both typefaces are bundled", /fontsource-variable\/outfit/.test(readFileSync(join(SRC, "main.tsx"), "utf8")) && /fontsource-variable\/geist"/.test(readFileSync(join(SRC, "main.tsx"), "utf8")));
const tok = readFileSync(join(SRC, "styles", "tokens.css"), "utf8");
ok("the tokens carry the language's one accent, 44 px tap and 150 ms motion", /--b600:\s*#2f5fe0/i.test(tok) && /--tap:\s*44px/.test(tok) && /--dur:\s*150ms/.test(tok));
ok("light only: no dark scheme is declared", !/prefers-color-scheme:\s*dark|color-scheme:\s*dark/.test(readFileSync(join(SRC, "index.css"), "utf8") + tok));
const idx = readFileSync(join(SRC, "index.css"), "utf8");
ok("every button style is at least the 44 px tap target", /min-height:\s*var\(--tap\)/.test(idx) && !/btn-sm\s*\{[^}]*min-height/.test(idx));

console.log("\n  the office card's plain English");
const S = (over: Partial<PrimarySummaryLike> = {}): PrimarySummaryLike => ({
  mode: "on", machineId: "office-pc-1", keyHash: "ab".repeat(32), pin: { ok: true, problem: null, at: "2026-11-15T10:00:00.000Z" }, registered: true,
  claim: { running: true, lastLookAt: "2026-11-15T10:00:00.000Z", lastWorkAt: null, lastNote: "idle", errors: 0, holdsLease: true, pausedReason: null, stoppedBecause: [] },
  mirror: { running: true, lastLookAt: "2026-11-15T10:00:00.000Z", lastWorkAt: null, lastNote: "nothing due", errors: 0, holds: 0, alarms: 0 },
  preflight: { at: "2026-11-15T10:00:00.000Z", ready: true, lines: [], lastError: null }, startProblems: [], at: "2026-11-15T10:00:30.000Z", ...over,
});
const NOW = new Date("2026-11-15T10:05:00.000Z");
const SETTING_NAMES = /MKCP_|SUPABASE_|PUSH_AGENT|GUID|\.env|sandbox|journal|sha-256|rpc|erp_/i;
{
  const lines = [
    plainPreflightLine({ name: "the primary settings are complete", ok: true, detail: "" }),
    plainPreflightLine({ name: "setting", ok: false, detail: "MKCP_ERP_AGENT_KEY is not set (the machine's own key; only its sha-256 is registered in the database)" }),
    plainPreflightLine({ name: "setting", ok: false, detail: "refused: MKCP_PRIMARY_COMPANY_GUID is not set, so this machine cannot prove which company it holds." }),
    plainPreflightLine({ name: "setting", ok: false, detail: "PUSH_AGENT_ENABLED=true: the old push agent would also write to the live books." }),
    plainPreflightLine({ name: "Tally answers on its port", ok: false, detail: "connect ECONNREFUSED" }),
    plainPreflightLine({ name: "the open company carries the pinned GUID", ok: false, detail: "refused: not the pinned company. \"X\" is open under a GUID other than MKCP_PRIMARY_COMPANY_GUID." }),
    plainPreflightLine({ name: "the open company carries the pinned GUID", ok: false, detail: "refused: company \"X\" is not open in Tally, so its GUID cannot be checked." }),
    plainPreflightLine({ name: "the database is reachable and this machine's key is registered as primary", ok: false, detail: "machine office-pc-1 is not registered" }),
    plainPreflightLine({ name: "the database is reachable and this machine's key is registered as primary", ok: false, detail: "the database says role \"none\", not primary" }),
    plainPreflightLine({ name: "the database is reachable and this machine's key is registered as primary", ok: false, detail: "no database client on this machine (sandbox, offline or no service key)" }),
  ];
  ok("every known line becomes a sentence with no setting name, file name or jargon", lines.every((l) => !SETTING_NAMES.test(l.text)), lines.filter((l) => SETTING_NAMES.test(l.text)).map((l) => l.text).join(" | "));
  ok("a known line keeps no raw text to show", lines.slice(1, 4).every((l) => l.raw === null));
  ok("a passing line says it passed", lines[0].ok && /filled in/.test(lines[0].text));
  const odd = plainPreflightLine({ name: "setting", ok: false, detail: "MKCP_NEW_THING is wrong" });
  ok("a line with no sentence yet gets a safe sentence and keeps the agent's words apart", !SETTING_NAMES.test(odd.text) && odd.raw === "MKCP_NEW_THING is wrong");
  ok("the queue notes are plain", [plainClaimNote("idle"), plainClaimNote("2 job(s) worked, 0 settled"), plainClaimNote("claiming is paused for 40 s more: x"), plainClaimNote("the queue lease is held by another")].every((p) => p && !SETTING_NAMES.test(p.text) && p.raw === null));
  ok("the mirror notes are plain", [plainMirrorNote("nothing due"), plainMirrorNote("full:swapped"), plainMirrorNote("incremental:swapped, check:ok")].every((p) => p && !SETTING_NAMES.test(p.text) && p.raw === null));
  ok("the stop reasons are plain", [plainStop("Tally may be showing a message on the office screen; the queue is paused"), plainStop("this clock is 90 s off the database's; claiming stopped"), plainStop("the journal could not be written")].every((p) => !SETTING_NAMES.test(p.text) && p.raw === null));
  ok("no sentence uses an em dash or the word sandbox", lines.every((l) => !/—/.test(l.text)));
}
{
  ok("a pin that was never checked is not a match", pinSentence(S({ pin: { ok: null, problem: null, at: null } }), NOW).tone === "unknown");
  ok("a pin that matched says so", pinSentence(S(), NOW).tone === "good");
  ok("a pin that failed says so and names no setting", (() => { const p = pinSentence(S({ pin: { ok: false, problem: "refused: not the pinned company", at: "2026-11-15T10:00:00.000Z" } }), NOW); return p.tone === "bad" && !SETTING_NAMES.test(p.text); })());
  ok("registered is unknown until a report says", registeredSentence(S({ registered: null })).tone === "unknown" && registeredSentence(S({ registered: true })).tone === "good" && registeredSentence(S({ registered: false })).tone === "bad");
  ok("the office card shows only when the mode is on", primaryIsOn(S()) && primaryIsOn(S({ mode: "on-not-running" })) && !primaryIsOn(S({ mode: "off" })) && !primaryIsOn(null));
  ok("office fact: ready, not ready, not started, unread", officeFact(S()).value === "Ready" && officeFact(S({ preflight: { at: "x", ready: false, lines: [{ name: "a", ok: false, detail: "" }], lastError: null } })).value === "Not ready"
    && officeFact(S({ mode: "on-not-running" })).value === "Not started" && officeFact(null).tone === "unknown");
  ok("a mode that has not reported is Starting, never Ready", officeFact(S({ preflight: { at: null, ready: null, lines: [], lastError: null } })).value === "Starting");
  ok("last job and last copy: looked-and-found-none is not the same as did-something", claimFact(S(), NOW).value === "None yet" && /looked/.test(claimFact(S(), NOW).sub)
    && claimFact(S({ claim: { ...S().claim, lastWorkAt: "2026-11-15T10:00:00.000Z" } }), NOW).value === "5 minutes ago" && mirrorRunFact(S(), NOW).value === "None yet");
  ok("time is told in words", whenText("2026-11-15T10:04:50.000Z", NOW) === "just now" && /^5 minutes ago, at /.test(whenText("2026-11-15T10:00:00.000Z", NOW)));
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
