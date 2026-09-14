/**
 * EXPLORATION 4 — the nested blocks, where the GST detail actually lives.
 *
 * Flat methods on a StockItem do not return `GSTRate`, `HSNCode` or `Taxability`
 * at all. They sit inside `.LIST` blocks, and those blocks are where the rate a
 * voucher is taxed at is really decided — which is exactly what GSTR-1's "Tax
 * Rate is not specified" exception turns on.
 *
 * The wildcard exposes 68 blocks on Ledger and 38 on StockItem. Most are empty
 * ceremony, as on vouchers (27 of 32 blocks there are never populated). This
 * separates the few that carry data from the many that do not, and shows what is
 * inside the ones that count.
 *
 *   npx tsx scripts/explore-blocks.ts
 */
import { writeFileSync } from "node:fs";
import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { convertCompanies } from "../src/converters/convert.js";

const TALLY_URL = process.env.TALLY_URL || "http://localhost:9000";
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Voucher is date-filtered; with every field and no filter it is 229MB. */
const VOUCHER_DAY = 20260811;
const CLASSES: Array<[string, string]> = [
  ["StockItem", "STOCKITEM"],
  ["Ledger", "LEDGER"],
  ["VoucherType", "VOUCHERTYPE"],
  ["Voucher", "VOUCHER"],
  ["Group", "GROUP"],
  ["StockGroup", "STOCKGROUP"],
];

const xmlFor = (company: string, type: string) => {
  const filtered = type === "Voucher";
  return `<ENVELOPE>
<HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>BlockProbe</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="BlockProbe" ISMODIFY="No"><TYPE>${esc(type)}</TYPE>
<NATIVEMETHOD>*</NATIVEMETHOD>
${filtered ? "<FILTER>BlockDate</FILTER>" : ""}
</COLLECTION>
${filtered ? `<SYSTEM TYPE="Formulae" NAME="BlockDate">($$YearOfDate:$Date * 10000 + $$MonthOfDate:$Date * 100 + $$DayOfDate:$Date) = ${VOUCHER_DAY}</SYSTEM>` : ""}
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
};

const clean = (s: string) => s.replace(/&#\d+;/g, "").trim();
const EMPTY = /^(|no|0|0\.00|not applicable|\s*)$/i;

async function healthy(): Promise<boolean> {
  try { return convertCompanies(await tallyPost(TALLY_URL, HEALTH_XML, 8_000)).length > 0; }
  catch { return false; }
}

async function main() {
  const company = convertCompanies(await tallyPost(TALLY_URL, HEALTH_XML, 10_000))[0]?.name;
  if (!company) throw new Error("No company loaded");
  console.log(`company "${company}"\n`);
  const out: Record<string, unknown> = {};

  for (const [type, node] of CLASSES) {
    let raw: string;
    try {
      raw = await tallyPost(TALLY_URL, xmlFor(company, type), 240_000, true) as string;
    } catch (e) {
      console.log(`✗ ${type} — ${(e as Error).message}`);
      if (!await healthy()) { console.log("\n⚠ Tally stopped answering. STOPPING."); return; }
      continue;
    }

    const objs = [...raw.matchAll(new RegExp(`<${node}\\b[^>]*>([\\s\\S]*?)</${node}>`, "g"))].map(m => m[1]);
    console.log(`\n\x1b[1m── ${type} — ${objs.length} objects, ${Math.round(raw.length / 1024)}KB ──\x1b[0m`);

    // block name -> { seen, filled, innerFields:Set, sample }
    const blocks = new Map<string, { seen: number; filled: number; fields: Set<string>; sample: string }>();
    for (const o of objs) {
      // Innermost-first matching would nest badly; take each named block and
      // look only at its own direct content.
      for (const m of o.matchAll(/<([A-Z][A-Z0-9_.]*\.LIST)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
        const name = m[1], inner = m[2];
        const e = blocks.get(name) ?? { seen: 0, filled: 0, fields: new Set<string>(), sample: "" };
        e.seen++;
        const hasContent = /<[A-Z][A-Z0-9_.]*(?:\s[^>]*)?>[^<\s]/.test(inner);
        if (hasContent) {
          e.filled++;
          for (const f of inner.matchAll(/<([A-Z][A-Z0-9_]*)(?:\s[^>]*)?>([^<]*)<\/\1>/g)) {
            if (!EMPTY.test(clean(f[2]))) e.fields.add(f[1]);
          }
          if (!e.sample) e.sample = inner.replace(/\s+/g, " ").trim().slice(0, 150);
        }
        blocks.set(name, e);
      }
    }

    const filled = [...blocks.entries()].filter(([, e]) => e.filled > 0).sort((a, b) => b[1].filled - a[1].filled);
    const empty = [...blocks.entries()].filter(([, e]) => e.filled === 0);

    for (const [name, e] of filled) {
      console.log(`  \x1b[32m✓\x1b[0m ${name.padEnd(30)} ${String(e.filled).padStart(5)}/${String(e.seen).padEnd(5)}  ${[...e.fields].slice(0, 8).join(", ")}`);
      if (e.sample) console.log(`     \x1b[90m${e.sample}\x1b[0m`);
    }
    if (empty.length) console.log(`  \x1b[90m· ${empty.length} blocks always empty: ${empty.map(([n]) => n).slice(0, 8).join(", ")}${empty.length > 8 ? " …" : ""}\x1b[0m`);

    out[type] = {
      objects: objs.length, bytes: raw.length,
      populated: filled.map(([n, e]) => ({ block: n, filled: e.filled, seen: e.seen, fields: [...e.fields] })),
      alwaysEmpty: empty.map(([n]) => n),
    };

    if (!await healthy()) { console.log("\n⚠ Tally stopped answering. STOPPING."); break; }
  }

  writeFileSync("./exploration-blocks.json", JSON.stringify(out, null, 2));
  console.log("\nSaved to exploration-blocks.json");
}

main().catch(e => console.error("FAILED:", e.message));
