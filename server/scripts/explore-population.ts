/**
 * EXPLORATION 3 — do the interesting fields actually carry data?
 *
 * Enumeration found fields that would delete whole chunks of planned work:
 * credit terms on the party master, phone and WhatsApp numbers, reorder levels,
 * a cheque-clearance date. But a field existing proves nothing. `BILLDUE` and
 * `BILLOVERDUE` exist on the Bills Receivable report and come back EMPTY on every
 * row, and believing otherwise cost a wrong conclusion about ageing.
 *
 * So: for each field, on what percentage of objects is it populated, and what do
 * the values look like? That is the difference between "Tally can tell us" and
 * "Tally does tell us".
 *
 *   npx tsx scripts/explore-population.ts
 */
import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { convertCompanies } from "../src/converters/convert.js";

const TALLY_URL = process.env.TALLY_URL || "http://localhost:9000";
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Field sets worth settling, and why each one matters. */
const QUESTIONS: Array<{ type: string; node: string; why: string; fields: string[]; filter?: string }> = [
  {
    type: "Ledger", node: "LEDGER",
    why: "Do parties carry credit terms and contact details? Would settle the call list.",
    fields: ["Name", "Parent", "BillCreditPeriod", "OverrideCreditLimit", "IsBillWiseOn",
      "LedgerMobile", "LedgerPhone", "Email", "LedgerContact", "IsDefaultWhatsAppNum",
      "PriceLevel", "IsInterestOn", "AlterID", "CreatedDate", "AlteredOn"],
  },
  {
    type: "StockItem", node: "STOCKITEM",
    why: "Are reorder levels and per-item pricing configured, or is the dashboard right to compute its own?",
    fields: ["Name", "ReorderAsHigher", "ReorderPeriodLength", "MinOrderAsHigher",
      "MinOrderPeriodLength", "Rate", "RateOfMRP", "PriceLevel", "GSTRate", "HSNCode",
      "SrcOfGSTDetails", "Taxability", "AlterID"],
  },
  {
    type: "Bills", node: "BILL",
    why: "Is CLEAREDON populated? That is the whole 'which cheques are pending' question.",
    fields: ["Name", "Parent", "BillDate", "ClearedOn", "IsAdvance", "BillID",
      "BillCreditPeriod", "ClosingBalance", "FinalBalance"],
  },
  {
    type: "Godown", node: "GODOWN",
    why: "The masters loader reports 1 godown, the collection returns 2. Stock could be landing somewhere unexpected.",
    fields: ["Name", "Parent", "HasNoSpace", "AlterID"],
  },
];

const collectionXml = (company: string, type: string, fields: string[]) => `<ENVELOPE>
<HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>PopProbe</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="PopProbe" ISMODIFY="No"><TYPE>${esc(type)}</TYPE>
${fields.map(f => `<NATIVEMETHOD>${esc(f)}</NATIVEMETHOD>`).join("")}
</COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;

/** Tally's several ways of saying "nothing here". */
const EMPTY = /^(|no|0|0\.00|not applicable|\s*|&#4;\s*not applicable)$/i;
const clean = (s: string) => s.replace(/&#\d+;/g, "").trim();

async function healthy(): Promise<boolean> {
  try { return convertCompanies(await tallyPost(TALLY_URL, HEALTH_XML, 8_000)).length > 0; }
  catch { return false; }
}

async function main() {
  const company = convertCompanies(await tallyPost(TALLY_URL, HEALTH_XML, 10_000))[0]?.name;
  if (!company) throw new Error("No company loaded");
  console.log(`company "${company}"\n`);

  for (const q of QUESTIONS) {
    console.log(`\n\x1b[1m── ${q.type} ${"─".repeat(Math.max(0, 44 - q.type.length))}\x1b[0m`);
    console.log(`\x1b[90m   ${q.why}\x1b[0m\n`);

    let raw: string;
    try {
      raw = await tallyPost(TALLY_URL, collectionXml(company, q.type, q.fields), 180_000, true) as string;
    } catch (e) {
      console.log(`  ✗ ${(e as Error).message}`);
      if (!await healthy()) { console.log("\n⚠ Tally stopped answering. STOPPING."); return; }
      continue;
    }

    const objs = [...raw.matchAll(new RegExp(`<${q.node}\\b[^>]*>([\\s\\S]*?)</${q.node}>`, "g"))].map(m => m[1]);
    if (!objs.length) { console.log("  (no objects returned)"); continue; }

    for (const field of q.fields) {
      const tag = field.toUpperCase();
      let present = 0, populated = 0;
      const samples: string[] = [];
      for (const o of objs) {
        // Attributes are normal on these tags, so never anchor on ">".
        const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(o);
        if (!m) continue;
        present++;
        const v = clean(m[1]);
        if (!EMPTY.test(v)) {
          populated++;
          if (samples.length < 3 && !samples.includes(v)) samples.push(v.slice(0, 26));
        }
      }
      if (!present) { console.log(`  \x1b[90m·\x1b[0m ${field.padEnd(22)} field not returned`); continue; }
      const pct = Math.round(populated / objs.length * 100);
      const bar = pct >= 50 ? "\x1b[32m" : pct > 0 ? "\x1b[33m" : "\x1b[90m";
      console.log(`  ${bar}${String(pct).padStart(3)}%\x1b[0m ${field.padEnd(22)} ${String(populated).padStart(4)}/${objs.length}  ${samples.join(" · ")}`);
    }

    if (!await healthy()) { console.log("\n⚠ Tally stopped answering. STOPPING."); return; }
  }
  console.log("\nTally still healthy.");
}

main().catch(e => console.error("FAILED:", e.message));
