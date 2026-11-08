/**
 * Task 2-5, agent half (lane T2c): the GST rules the web app and the agent each
 * keep a copy of, run as one shared list of cases.
 *
 *   contracts/gst-twins.json   a byte copy of the web repo's
 *                              web-dashboard/contracts/gst-twins.json (50 cases,
 *                              14 rules). The answers are the web app's and are
 *                              never edited here: a change goes through the web
 *                              generator (scripts/contracts/build-gst-twins.ts)
 *                              and a logged decision, then the file is copied
 *                              again and gst-twins.sha256 is rewritten.
 *   contracts/gst-twins.sha256 the hash of that copy (line endings read as LF).
 *
 * This script:
 *   1. checks the copy against the recorded hash (it fails if anyone edits the
 *      file or replaces it without updating the hash), and against the web
 *      file itself when the web repo sits beside this one;
 *   2. maps every rule name to the agent's own function and gives each case's
 *      input, failing on any answer that is not exactly the shared one;
 *   3. pins the four India-time filed-through instants again from UTC, so the
 *      answer cannot depend on the machine's time zone;
 *   4. checks that every GSTIN in the file is from the fake ZZZ series.
 *
 * Run it in the office zone and in UTC and in a far zone (the filed-through
 * cases must not move):
 *   npx tsx scripts/test-gst-contract.ts
 *   TZ=UTC npx tsx scripts/test-gst-contract.ts
 *   TZ=Pacific/Kiritimati npx tsx scripts/test-gst-contract.ts
 * (PowerShell: $env:TZ='UTC'; npx tsx scripts/test-gst-contract.ts)
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gstReturnFiledThrough, filedBoundaryFor, EWAY_BILL_THRESHOLD } from "../src/services/pushGuard.js";
import { financialYearOf, remoteIdFor } from "../src/services/remoteId.js";
import { classifyTransfer, dbKind } from "../src/services/fileTransferKind.js";
import {
  GST_STATE_BY_CODE, sameState, stateFromGstin, codeForState, normalizeGstin, isGstinChecksumValid,
  isCashLikeParty, PIN_RE, HSN_RE,
} from "../src/services/gstIdentity.js";
import { resolveWebDir } from "./guardrails/lib.js";

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? `: ${detail}` : ""}`); }
};
const lf = (text: string) => text.replace(/\r\n/g, "\n");
const sha = (text: string) => createHash("sha256").update(lf(text)).digest("hex");

type Case = { rule: string; why: string; in: unknown[]; out: unknown; pinned?: { out: unknown; source: string } };
type Fixture = { contract: string; version: number; rules: string[]; cases: Case[] };

const mine = join(__dirname, "..", "contracts", "gst-twins.json");
const hashFile = join(__dirname, "..", "contracts", "gst-twins.sha256");
const text = readFileSync(mine, "utf8");
const fx = JSON.parse(text) as Fixture;

console.log(`\n  GST rule set contract, agent copies (task 2-5), TZ=${process.env.TZ ?? "(machine)"}\n`);

// 1. The copy is the web's copy.
// Source of truth: web-dashboard/contracts/gst-twins.json in the web repo
// (kaxx4/MKCPWEB). The hash line in gst-twins.sha256 is the first word of the file.
const recorded = (readFileSync(hashFile, "utf8").split(/\r?\n/).find((l) => /^[0-9a-f]{64}\b/.test(l)) ?? "").slice(0, 64);
ok("the fixture copy matches the hash written in the agent repo", sha(text) === recorded, `${sha(text)} vs ${recorded || "(none)"}`);
const web = join(resolveWebDir(), "contracts", "gst-twins.json");
if (existsSync(web)) ok(`the copy here is byte-identical to the web repo's (${web})`, lf(readFileSync(web, "utf8")) === lf(text));
else console.log("  - the web repo was not found beside this one; the recorded hash is the check (set MKCP_WEB_DIR to compare directly)");
ok("the fixture is the gst-twins contract, version 1, 50 cases, 14 rules", fx.contract === "gst-twins" && fx.version === 1 && fx.cases.length === 50 && fx.rules.length === 14, `${fx.contract} v${fx.version} ${fx.cases.length}/${fx.rules.length}`);

// 2. Every rule, as the agent answers it.
const AGENT_RULES: Record<string, (...args: never[]) => unknown> = {
  /** Instant as an ISO string with its offset; answer YYYY-MM-DD. */
  filedThrough: (iso: string) => gstReturnFiledThrough(new Date(iso)),
  financialYear: (iso: string) => financialYearOf(iso),
  /** The web's identityKey is not in the contract: bulk money is web-only. */
  remoteId: (voucherType: string, voucherNumber: string, date: string | null) =>
    remoteIdFor({ voucherType, voucherNumber, ...(date ? { date } : {}) }),
  classifyTransfer: (filename: string, head: string) => classifyTransfer(filename, head),
  stateFromGstin: (gstin: string | null) => stateFromGstin(gstin),
  codeForState: (name: string | null) => codeForState(name),
  sameState: (a: string | null, b: string | null) => sameState(a, b),
  normalizeGstin: (s: string) => normalizeGstin(s),
  gstinChecksumValid: (s: string) => isGstinChecksumValid(s),
  pincode: (s: string) => PIN_RE.test(s),
  hsn: (s: string) => HSN_RE.test(s),
  cashLikeParty: (name: string | null) => isCashLikeParty(name),
  ewayThreshold: () => EWAY_BILL_THRESHOLD,
  stateTable: () => GST_STATE_BY_CODE,
};

const sortedKeys = (v: unknown): unknown =>
  v && typeof v === "object" && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortedKeys((v as Record<string, unknown>)[k])]))
    : v;
const same = (a: unknown, b: unknown) => JSON.stringify(sortedKeys(a)) === JSON.stringify(sortedKeys(b));
const show = (v: unknown) => { const s = JSON.stringify(v); return s.length > 90 ? `${s.slice(0, 90)}...` : s; };

ok("every rule in the fixture has an agent function, and no case names an unknown rule",
  fx.rules.every((r) => r in AGENT_RULES) && fx.cases.every((c) => fx.rules.includes(c.rule)));

for (const c of fx.cases) {
  const fn = AGENT_RULES[c.rule] as ((...a: unknown[]) => unknown) | undefined;
  let got: unknown;
  try { got = fn ? fn(...c.in) : "(no function)"; } catch (e) { got = `threw: ${(e as Error).message}`; }
  ok(`${c.rule}: ${c.why}`, same(got, c.out), `got ${show(got)}, shared answer ${show(c.out)}`);
}

// 3. India time, pinned from UTC instants, whatever zone this machine is set to.
const utc = (iso: string) => gstReturnFiledThrough(new Date(iso));
ok("18:30 UTC on the 10th is 00:00 IST on the 11th: still the due day (30-Sep)", utc("2026-11-10T18:30:00Z") === "2026-09-30");
ok("18:29 UTC on the 10th is 23:59 IST on the 10th: 30-Sep", utc("2026-11-10T18:29:00Z") === "2026-09-30");
ok("18:29 UTC on the 11th is 23:59 IST on the 11th: still 30-Sep", utc("2026-11-11T18:29:00Z") === "2026-09-30");
ok("18:30 UTC on the 11th is 00:00 IST on the 12th: 31-Oct", utc("2026-11-11T18:30:00Z") === "2026-10-31");
ok("a payment is bound by no filed period at the same instant", filedBoundaryFor("Payment", new Date("2026-11-11T18:30:00Z")) === "");
ok("a sale at 18:30 UTC on the 11th is bound by 31-Oct (unless MKCP_FILED_THROUGH is set)",
  (process.env.MKCP_FILED_THROUGH ?? "").trim() !== "" || filedBoundaryFor("SALES", new Date("2026-11-11T18:30:00Z")) === "2026-10-31");

// 4. What the agent writes to file_transfers.kind. The live enum holds five labels
// (price_list, purchase_xml, packing_list, sales_order, unknown); "sales_invoice" is
// the shared answer for a split sales file but the enum rejects it, so the insert
// carries "unknown" (same as the web's dbKind) until a migration adds the label.
const ENUM = new Set(["price_list", "purchase_xml", "packing_list", "sales_order", "unknown"]);
const sent = fx.cases.filter((c) => c.rule === "classifyTransfer").map((c) => dbKind(c.out as never));
ok("every kind the agent would write is a label the live enum holds", sent.every((k) => ENUM.has(k)), sent.filter((k) => !ENUM.has(k)).join(", "));
ok("a split sales file is written as unknown, not refused by the enum", dbKind("sales_invoice") === "unknown");
ok("the other kinds are written as they are", (["price_list", "purchase_xml", "packing_list", "sales_order", "unknown"] as const).every((k) => dbKind(k) === k));

// 5. Fake data only.
const gstinShaped = /\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/g;
const found = [...text.matchAll(gstinShaped)].map((m) => m[0]);
ok("every GSTIN in the fixture is from the fake ZZZ series", found.length > 0 && found.every((g) => g.slice(2, 5) === "ZZZ"), found.filter((g) => g.slice(2, 5) !== "ZZZ").join(", "));

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
