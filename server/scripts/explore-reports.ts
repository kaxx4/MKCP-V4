/**
 * EXPLORATION 5 — which reports will Tally render over XML?
 *
 * Unlike object types, an unrecognised REPORT name fails cleanly and does not
 * raise a modal — verified repeatedly. So this one sweep is free, and worth
 * doing broadly.
 */
import { writeFileSync } from "node:fs";
import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { convertCompanies } from "../src/converters/convert.js";

const TALLY_URL = process.env.TALLY_URL || "http://localhost:9000";
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const REPORTS = [
  // Already confirmed — included so the map is complete in one artefact.
  "Trial Balance", "Balance Sheet", "Profit and Loss", "Cash Flow",
  "Stock Summary", "Bills Receivable", "Bills Payable", "Ledger",
  // Accounting
  "Day Book", "Cash Book", "Bank Book", "Journal Register", "Sales Register",
  "Purchase Register", "Group Summary", "Ledger Vouchers", "Outstandings",
  "Receivables", "Payables", "Bills Outstanding", "Ageing Analysis",
  "Funds Flow", "Ratio Analysis", "Cost Centre Summary",
  // Inventory
  "Stock Vouchers", "Godown Summary", "Movement Analysis", "Stock Query",
  "Reorder Status", "Sales Order Summary", "Purchase Order Summary",
  "Stock Ageing Analysis", "Batch Summary", "Item Wise Profitability",
  // GST
  "GSTR-1", "GSTR-2", "GSTR-3B", "GST Rate Setup", "HSN Summary",
  "GST Annual Computation", "Input Tax Credit", "GST Portal",
];

async function healthy() {
  try { return convertCompanies(await tallyPost(TALLY_URL, HEALTH_XML, 8_000)).length > 0; }
  catch { return false; }
}

(async () => {
  const company = convertCompanies(await tallyPost(TALLY_URL, HEALTH_XML, 10_000))[0]!.name;
  console.log(`company "${company}"\n`);
  const out: Array<{ id: string; ok: boolean; bytes: number; ms: number; lines: number; sample: string }> = [];

  for (const id of REPORTS) {
    const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>${esc(id)}</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY>
<SVFROMDATE TYPE="Date">1-Apr-2026</SVFROMDATE><SVTODATE TYPE="Date">11-Sep-2026</SVTODATE>
</STATICVARIABLES></DESC></BODY></ENVELOPE>`;
    const t0 = Date.now();
    let raw = "", err = "";
    try { raw = await tallyPost(TALLY_URL, xml, 120_000, true) as string; }
    catch (e) { err = (e as Error).message; }
    const ms = Date.now() - t0;

    if (err) { console.log(`  ✗ ${id.padEnd(26)} ${err.slice(0, 40)}`); }
    else if (/Unknown Request|Could not find/i.test(raw)) { console.log(`  \x1b[90m·\x1b[0m ${id.padEnd(26)} not a report here`); }
    else if (/<LINEERROR>/.test(raw)) { console.log(`  ✗ ${id.padEnd(26)} ${/<LINEERROR>([^<]*)/.exec(raw)![1].slice(0, 40)}`); }
    else {
      const names = [...raw.matchAll(/<DSPDISPNAME>([^<]*)</g)].map(m => m[1].replace(/&#\d+;/g, "").trim()).filter(Boolean);
      const rows = names.length || [...raw.matchAll(/<[A-Z]+FIXED>/g)].length;
      console.log(`  \x1b[32m✓\x1b[0m ${id.padEnd(26)} ${String(Math.round(raw.length / 1024)).padStart(6)}KB ${String(ms).padStart(6)}ms  ${String(rows).padStart(5)} rows  ${names.slice(0, 3).join(" · ").slice(0, 50)}`);
      out.push({ id, ok: true, bytes: raw.length, ms, lines: rows, sample: names.slice(0, 5).join(" | ") });
    }
    if (!await healthy()) { console.log(`\n⚠ Tally stopped after "${id}".`); break; }
  }
  writeFileSync("./exploration-reports.json", JSON.stringify(out, null, 2));
  console.log(`\n${out.length} reports render over XML.`);
})();
