/**
 * Which of Tally's own REPORTS will it serve over XML?
 *
 * Safe to sweep, unlike collection TYPEs. An unknown `<TYPE>` on a Collection
 * raises a modal and blocks the port until a human restarts TallyPrime; an
 * unknown report name answers `Could not find Report 'X'!` in a LINEERROR and
 * costs nothing. Proved on 17-Sep-2026 across six wrong names.
 *
 * Worth asking because a report is a computed answer. Anything Tally will
 * total for us is something the mirror does not have to hold, recompute, or
 * get subtly wrong — ageing, stock valuation, a period P&L.
 *
 *   npx tsx scripts/fidelity/explore-reports.ts
 */
import { tallyPost } from "../../src/tally.js";
import { U, company, esc } from "./harness.js";

const FROM = "20260401";
const TO = "20260930";

const NAMES = [
  // money
  "Trial Balance", "Balance Sheet", "Profit and Loss", "Profit & Loss",
  "Cash Flow", "Funds Flow", "Ratio Analysis", "Group Summary",
  // receivables / payables
  "Bills Receivable", "Bills Payable", "Outstandings", "Ledger Outstandings",
  "Bills Outstanding", "Ageing Analysis", "Receivables", "Payables",
  // registers
  "Sales Register", "Purchase Register", "Journal Register", "Day Book",
  "Ledger Vouchers", "Voucher Register",
  // stock
  "Stock Summary", "Godown Summary", "Movement Analysis", "Stock Query",
  "Item Movement Analysis", "Reorder Status", "Stock Ageing Analysis",
  "Godown Vouchers", "Batch Summary", "Sales Order Book", "Purchase Order Book",
  // masters
  "List of Accounts", "Multi Voucher Printing",
  // banking
  "Bank Reconciliation", "Cheque Register", "Post-dated Summary",
  // gst
  "GST Rate Setup", "HSN Summary", "GST Vouchers",
];

const okTags = (xml: string): string =>
  [...new Set([...xml.matchAll(/<([A-Z0-9_.]+)[ >]/gi)].map((m) => m[1]))]
    .filter((t) => !/^(ENVELOPE|HEADER|BODY|DESC|DATA|VERSION|STATUS)$/i.test(t))
    .slice(0, 8).join(", ");

async function main(): Promise<void> {
  const co = await company();
  console.log(`\ncompany  ${co}\nperiod   ${FROM}–${TO}\n`);
  const works: { name: string; bytes: number; tags: string }[] = [];
  const missing: string[] = [];
  const odd: string[] = [];

  for (const name of NAMES) {
    const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>${esc(name)}</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(co)}</SVCURRENTCOMPANY>
<SVFROMDATE>${FROM}</SVFROMDATE><SVTODATE>${TO}</SVTODATE></STATICVARIABLES></DESC></BODY></ENVELOPE>`;
    let res: string;
    try {
      res = (await tallyPost(U, xml, 60_000, true)) as string;
    } catch (e) {
      odd.push(`${name} — ${(e as Error).message}`);
      continue;
    }
    if (/Could not find Report/i.test(res)) { missing.push(name); continue; }
    const err = /<LINEERROR>([\s\S]*?)<\/LINEERROR>/i.exec(res);
    if (err) { odd.push(`${name} — ${err[1].trim().slice(0, 70)}`); continue; }
    works.push({ name, bytes: res.length, tags: okTags(res) });
  }

  console.log(`── ${works.length} reports answered ${"─".repeat(40)}`);
  for (const w of works.sort((a, b) => b.bytes - a.bytes)) {
    console.log(`  ${w.name.padEnd(26)} ${String(Math.round(w.bytes / 1024)).padStart(5)} KB   ${w.tags}`);
  }
  console.log(`\n── ${missing.length} not found (harmless) ${"─".repeat(30)}`);
  console.log(`  ${missing.join(", ")}`);
  if (odd.length) {
    console.log(`\n── ${odd.length} answered with something else ${"─".repeat(20)}`);
    odd.forEach((o) => console.log(`  ${o}`));
  }
  console.log("");
}

main().catch((e) => { console.error("ERR:", e.message); process.exit(1); });
