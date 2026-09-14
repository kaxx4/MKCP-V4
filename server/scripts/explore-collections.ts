/**
 * EXPLORATION 1 — what object classes will Tally's server hand over?
 *
 * ── The constraint that shapes this script ────────────────────────────────
 * An unrecognised object type does NOT fail politely. Tally raises
 *
 *     Internal Error. Contact Tally Solutions.  Incorrect Object Type!
 *
 * as a blocking modal, which wedges the XML port until a human restarts the
 * application. (An unrecognised *report name*, by contrast, returns cleanly —
 * the two are not alike, and assuming they were cost a restart.)
 *
 * So this cannot be a brute-force sweep: every wrong guess costs the operator an
 * interruption. Three consequences:
 *
 *   1. The default list holds only types documented in TDL and therefore very
 *      likely to exist. Speculative names live behind --risky.
 *   2. Progress is persisted after EVERY probe, so a freeze costs one probe
 *      rather than the whole run, and the next run resumes where it stopped.
 *   3. The timeout is short. A valid collection answers in under 100ms; waiting
 *      90s only delays discovering that Tally is already showing a dialog.
 *
 *   npx tsx scripts/explore-collections.ts              # documented types
 *   npx tsx scripts/explore-collections.ts --risky      # + speculative ones
 *   npx tsx scripts/explore-collections.ts --reset      # start the map over
 */
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { convertCompanies } from "../src/converters/convert.js";

const TALLY_URL = process.env.TALLY_URL || "http://localhost:9000";
const RISKY = process.argv.includes("--risky");
const RESET = process.argv.includes("--reset");
const STATE = "./exploration-collections.json";
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Types named in Tally's own TDL documentation — low risk. */
const DOCUMENTED: Array<[string, string[]]> = [
  ["masters — accounting", ["Group", "Ledger", "CostCentre", "CostCategory", "Currency", "Budget", "VoucherType", "Company"]],
  ["masters — inventory", ["StockItem", "StockGroup", "StockCategory", "Godown", "Unit"]],
  ["transactions", ["Voucher", "Bills"]],
  // Payroll is outside the agreed scope (accounting + inventory + GST) and is
  // where the first two freezes came from: `AttendanceType` is valid but
  // `EmployeeGroup` is not, and an invalid type costs a restart. Not worth it.
];

/** Plausible but unverified. Each of these may cost a restart. */
/**
 * Speculative types, each of which may cost the operator a restart.
 *
 * Four were tried. Three were invalid and froze Tally: `ScenarioInfo`,
 * `EmployeeGroup`, `GSTRegistration`. Only `TaxUnit` worked.
 *
 * `Report` and `Function` are deliberately NOT here. They are TDL *definition*
 * types rather than data object types, so they are very unlikely to be valid as
 * a collection TYPE — and the appeal was only ever that self-description would
 * turn the rest of the map into enumeration. At one restart per wrong guess,
 * and with the hit rate at one in four, that is not a trade worth making.
 */
const SPECULATIVE: Array<[string, string[]]> = [
  ["GST & statutory", ["TaxUnit"]],
];

type Status = "ok" | "empty" | "error" | "froze";
interface Finding {
  group: string; type: string; status: Status;
  objects: number; bytes: number; ms: number; node?: string; fields?: string[]; detail?: string;
}

const collectionXml = (company: string, type: string) => `<ENVELOPE>
<HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>Probe</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="Probe" ISMODIFY="No"><TYPE>${esc(type)}</TYPE>
<NATIVEMETHOD>Name</NATIVEMETHOD></COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;

async function healthy(): Promise<boolean> {
  try { return convertCompanies(await tallyPost(TALLY_URL, HEALTH_XML, 8_000)).length > 0; }
  catch { return false; }
}

/**
 * Which element is the OBJECT, rather than the most common tag?
 *
 * Counting the most frequent tag reports `Ledger` as 966 objects and
 * `VoucherType` as 48, because each object carries its own `<NAME>` plus a
 * language-name alias. The object element is the one named after the type.
 */
function objectNode(raw: string, type: string): { node: string; count: number } | null {
  const want = type.toUpperCase();
  const counts = new Map<string, number>();
  for (const m of raw.matchAll(/<([A-Z][A-Z0-9_]*)\b[^>]*>/g)) {
    counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  const structural = new Set(["ENVELOPE", "HEADER", "BODY", "DATA", "COLLECTION", "DESC", "STATICVARIABLES", "TALLYMESSAGE", "NAME", "LANGUAGENAME", "VERSION"]);
  // Exact match first — Bills comes back as <BILL>, so also try the singular.
  for (const cand of [want, want.replace(/S$/, "")]) {
    if (counts.has(cand)) return { node: cand, count: counts.get(cand)! };
  }
  const best = [...counts.entries()].filter(([n]) => !structural.has(n)).sort((a, b) => b[1] - a[1])[0];
  return best ? { node: best[0], count: best[1] } : null;
}

async function probe(company: string, group: string, type: string): Promise<Finding> {
  const started = Date.now();
  let raw = "";
  try {
    // Short: a valid collection answers in well under a second.
    raw = await tallyPost(TALLY_URL, collectionXml(company, type), 20_000, true) as string;
  } catch (e) {
    return { group, type, status: "froze", objects: 0, bytes: 0, ms: Date.now() - started, detail: (e as Error).message };
  }
  const ms = Date.now() - started;

  const lineErr = /<LINEERROR>([^<]*)/.exec(raw)?.[1]?.replace(/&#\d+;/g, "").trim();
  if (lineErr) return { group, type, status: "error", objects: 0, bytes: raw.length, ms, detail: lineErr };

  const obj = objectNode(raw, type);
  if (!obj || raw.length < 220) return { group, type, status: "empty", objects: 0, bytes: raw.length, ms };

  const first = new RegExp(`<${obj.node}\\b[^>]*>([\\s\\S]*?)</${obj.node}>`).exec(raw)?.[1] ?? "";
  const fields = [...new Set([...first.matchAll(/<([A-Z][A-Z0-9_.]*)>/g)].map(m => m[1]))];

  return { group, type, status: "ok", objects: obj.count, bytes: raw.length, ms, node: obj.node, fields };
}

function load(): Finding[] {
  if (RESET || !existsSync(STATE)) return [];
  try { return JSON.parse(readFileSync(STATE, "utf-8")) as Finding[]; } catch { return []; }
}

async function main() {
  const company = convertCompanies(await tallyPost(TALLY_URL, HEALTH_XML, 10_000))[0]?.name;
  if (!company) throw new Error("No company loaded");

  const findings = load();
  const done = new Set(findings.map(f => f.type));
  console.log(`company "${company}"`);
  if (done.size) console.log(`resuming — ${done.size} types already probed\n`);

  const plan = RISKY ? [...DOCUMENTED, ...SPECULATIVE] : DOCUMENTED;

  for (const [group, types] of plan) {
    const todo = types.filter(t => !done.has(t));
    if (!todo.length) continue;
    console.log(`\n\x1b[1m── ${group} ${"─".repeat(Math.max(0, 46 - group.length))}\x1b[0m`);

    for (const type of todo) {
      const f = await probe(company, group, type);
      findings.push(f);
      // Persist BEFORE the health check: if Tally is already dead, this probe's
      // verdict is the single most valuable thing the run produced.
      writeFileSync(STATE, JSON.stringify(findings, null, 2));

      const label = type.padEnd(20);
      if (f.status === "ok") console.log(`  \x1b[32m✓\x1b[0m ${label} ${String(f.objects).padStart(5)} × <${f.node}>  ${String(f.bytes).padStart(8)}B ${String(f.ms).padStart(5)}ms  ${(f.fields ?? []).length} fields`);
      else if (f.status === "empty") console.log(`  \x1b[90m·\x1b[0m ${label} recognised, none configured`);
      else console.log(`  \x1b[31m✗\x1b[0m ${label} ${f.status}${f.detail ? ` — ${f.detail.slice(0, 50)}` : ""}`);

      if (!await healthy()) {
        findings[findings.length - 1].status = "froze";
        findings[findings.length - 1].detail = "Incorrect Object Type! — blocking modal, port wedged";
        writeFileSync(STATE, JSON.stringify(findings, null, 2));
        console.log(`\n\x1b[31m⚠ "${type}" is not a valid object type — Tally is showing a modal and needs a restart.\x1b[0m`);
        console.log(`  Progress saved. Re-run this script after restarting; it resumes from here.`);
        return { died: type };
      }
    }
  }

  const ok = findings.filter(f => f.status === "ok");
  console.log(`\n${"═".repeat(62)}`);
  console.log(`${ok.length} working classes of ${findings.length} probed\n`);
  for (const f of ok.sort((a, b) => b.objects - a.objects)) {
    console.log(`  ${f.type.padEnd(18)} <${(f.node ?? "").padEnd(14)}> ${String(f.objects).padStart(5)} objects  ${(f.fields ?? []).length} fields`);
  }
  const dead = findings.filter(f => f.status === "froze").map(f => f.type);
  if (dead.length) console.log(`\n  invalid object types (each froze Tally): ${dead.join(", ")}`);
  return { died: null };
}

main()
  .then(r => { if (r?.died) process.exitCode = 2; })
  .catch(e => { console.error("FAILED:", e.message); process.exitCode = 1; });
