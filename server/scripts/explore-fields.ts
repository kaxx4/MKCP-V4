/**
 * EXPLORATION 2 — every field each object class can communicate.
 *
 * The point of the whole exercise: the GST fields we were not emitting are what
 * put every pushed invoice into GSTR-1's exception bucket, and we only found out
 * because a human opened a return. Fields we do not know about are the risk. So
 * enumerate them rather than discover them one incident at a time.
 *
 * Three ways to ask, cheapest and safest first:
 *
 *   1. No NATIVEMETHOD at all — Tally returns its own default field set for the
 *      class. Unambiguously valid syntax, zero risk.
 *   2. `<NATIVEMETHOD>*</NATIVEMETHOD>` — the documented "give me everything"
 *      wildcard. Tried only after (1), and first on the smallest class, so if it
 *      is not supported on this build the blast radius is one restart.
 *
 * `Voucher` is date-filtered throughout: unfiltered with all fields it is 229 MB
 * and over three minutes, which proves nothing that one day's worth does not.
 *
 *   npx tsx scripts/explore-fields.ts            # default field sets
 *   npx tsx scripts/explore-fields.ts --wildcard # also try NATIVEMETHOD *
 */
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { convertCompanies } from "../src/converters/convert.js";

const TALLY_URL = process.env.TALLY_URL || "http://localhost:9000";
const WILDCARD = process.argv.includes("--wildcard");
const STATE = "./exploration-fields.json";
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Smallest first: if something is going to freeze, freeze it cheaply. */
const CLASSES = [
  "StockCategory", "CostCentre", "Budget", "AttendanceType",
  "Company", "Godown", "Currency", "CostCategory",
  "Unit", "StockGroup", "VoucherType", "Group",
  "Bills", "Ledger", "StockItem", "Voucher",
];

/** One day of vouchers — enough to see the shape, not enough to hurt. */
const VOUCHER_DAY = 20260811;

interface FieldFinding {
  type: string; mode: "default" | "wildcard";
  status: "ok" | "empty" | "error" | "froze";
  node?: string; objects: number; bytes: number; ms: number;
  fields: string[]; blocks: string[]; detail?: string;
}

function collectionXml(company: string, type: string, methods: string[] | null): string {
  const filtered = type === "Voucher";
  return `<ENVELOPE>
<HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>FieldProbe</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="FieldProbe" ISMODIFY="No"><TYPE>${esc(type)}</TYPE>
${(methods ?? []).map(f => `<NATIVEMETHOD>${esc(f)}</NATIVEMETHOD>`).join("")}
${filtered ? "<FILTER>FieldProbeDate</FILTER>" : ""}
</COLLECTION>
${filtered ? `<SYSTEM TYPE="Formulae" NAME="FieldProbeDate">($$YearOfDate:$Date * 10000 + $$MonthOfDate:$Date * 100 + $$DayOfDate:$Date) = ${VOUCHER_DAY}</SYSTEM>` : ""}
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
}

async function healthy(): Promise<boolean> {
  try { return convertCompanies(await tallyPost(TALLY_URL, HEALTH_XML, 8_000)).length > 0; }
  catch { return false; }
}

async function probe(company: string, type: string, mode: "default" | "wildcard"): Promise<FieldFinding> {
  const started = Date.now();
  const base: FieldFinding = { type, mode, status: "ok", objects: 0, bytes: 0, ms: 0, fields: [], blocks: [] };
  let raw = "";
  try {
    raw = await tallyPost(TALLY_URL, collectionXml(company, type, mode === "wildcard" ? ["*"] : null), 120_000, true) as string;
  } catch (e) {
    return { ...base, status: "froze", ms: Date.now() - started, detail: (e as Error).message };
  }
  const ms = Date.now() - started;
  const lineErr = /<LINEERROR>([^<]*)/.exec(raw)?.[1]?.replace(/&#\d+;/g, "").trim();
  if (lineErr) return { ...base, status: "error", bytes: raw.length, ms, detail: lineErr };

  const node = type.toUpperCase().replace(/S$/, "") === "BILL" ? "BILL" : type.toUpperCase();
  const objs = [...raw.matchAll(new RegExp(`<${node}\\b[^>]*>([\\s\\S]*?)</${node}>`, "g"))].map(m => m[1]);
  if (!objs.length) return { ...base, status: "empty", bytes: raw.length, ms };

  // Union across several objects — a field absent from the first is still a field.
  //
  // Fields carry ATTRIBUTES, and missing that made every one of them invisible:
  //   <BILLCREDITPERIOD TYPE="Due Date" JD="46094" P="20 Days">20 Days</…>
  // The TYPE attribute is the useful part — it names the datatype (Date, Amount,
  // Logical, Number, String, Due Date), which is half of knowing what a field is.
  // JD is a Julian day number, i.e. the real date behind a human-readable string.
  const fields = new Set<string>(), blocks = new Set<string>();
  for (const o of objs.slice(0, 25)) {
    for (const m of o.matchAll(/<([A-Z][A-Z0-9_]*)((?:\s[^>]*)?)>([^<]*)<\/\1>/g)) {
      const type = /TYPE="([^"]*)"/.exec(m[2])?.[1];
      const extra = /\bJD="/.test(m[2]) ? "+JD" : "";
      fields.add(type ? `${m[1]}:${type}${extra}` : m[1]);
    }
    for (const m of o.matchAll(/<([A-Z][A-Z0-9_.]*\.LIST)\b/g)) blocks.add(m[1]);
  }
  return {
    ...base, node, objects: objs.length, bytes: raw.length, ms,
    fields: [...fields].sort(), blocks: [...blocks].sort(),
  };
}

function load(): FieldFinding[] {
  if (!existsSync(STATE)) return [];
  try { return JSON.parse(readFileSync(STATE, "utf-8")) as FieldFinding[]; } catch { return []; }
}

async function main() {
  const company = convertCompanies(await tallyPost(TALLY_URL, HEALTH_XML, 10_000))[0]?.name;
  if (!company) throw new Error("No company loaded");
  const findings = load();
  const done = new Set(findings.map(f => `${f.type}|${f.mode}`));
  console.log(`company "${company}"${done.size ? `  · resuming, ${done.size} probes already done` : ""}\n`);

  const modes: Array<"default" | "wildcard"> = WILDCARD ? ["default", "wildcard"] : ["default"];

  for (const mode of modes) {
    console.log(`\n\x1b[1m── ${mode === "default" ? "DEFAULT FIELD SETS" : "WILDCARD (NATIVEMETHOD *)"} ──\x1b[0m`);
    for (const type of CLASSES) {
      if (done.has(`${type}|${mode}`)) continue;
      const f = await probe(company, type, mode);
      findings.push(f);
      writeFileSync(STATE, JSON.stringify(findings, null, 2));

      const label = type.padEnd(15);
      if (f.status === "ok") {
        console.log(`  \x1b[32m✓\x1b[0m ${label} ${String(f.objects).padStart(5)} obj  ${String(f.fields.length).padStart(4)} fields  ${String(f.blocks.length).padStart(3)} blocks  ${String(Math.round(f.bytes / 1024)).padStart(6)}KB ${String(f.ms).padStart(6)}ms`);
      } else {
        console.log(`  \x1b[31m✗\x1b[0m ${label} ${f.status}${f.detail ? ` — ${f.detail.slice(0, 46)}` : ""}`);
      }

      if (!await healthy()) {
        findings[findings.length - 1].status = "froze";
        writeFileSync(STATE, JSON.stringify(findings, null, 2));
        console.log(`\n\x1b[31m⚠ Tally froze on ${type} (${mode}). Progress saved; re-run to resume.\x1b[0m`);
        return { died: `${type}/${mode}` };
      }
    }
  }

  console.log(`\n${"═".repeat(64)}`);
  for (const f of findings.filter(x => x.status === "ok" && x.mode === "default").sort((a, b) => b.fields.length - a.fields.length)) {
    console.log(`\n  \x1b[1m${f.type}\x1b[0m — ${f.fields.length} fields, ${f.blocks.length} nested blocks`);
    console.log(`    ${f.fields.slice(0, 18).join(", ")}${f.fields.length > 18 ? ` … +${f.fields.length - 18}` : ""}`);
    if (f.blocks.length) console.log(`    blocks: ${f.blocks.slice(0, 8).join(", ")}${f.blocks.length > 8 ? ` … +${f.blocks.length - 8}` : ""}`);
  }
  return { died: null };
}

main()
  .then(r => { if (r?.died) process.exitCode = 2; })
  .catch(e => { console.error("FAILED:", e.message); process.exitCode = 1; });
