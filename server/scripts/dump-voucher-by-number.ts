/**
 * Print one voucher's stored XML, verbatim.
 *
 * For settling questions about Tally's own element naming rather than guessing
 * at it — e.g. whether an invoice-shaped voucher really does come back carrying
 * both LEDGERENTRIES.LIST and ALLLEDGERENTRIES.LIST over the same lines.
 *
 * Single-day scope, so entry blocks are safe to request.
 *
 *   npx tsx scripts/dump-voucher-by-number.ts <voucherNumber> [YYYY-MM-DD]
 */
import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { convertCompanies } from "../src/converters/convert.js";

const U = process.env.TALLY_URL || "http://localhost:9000";
const WANT = process.argv[2] ?? "";
const DAY = (process.argv[3] && /^\d{4}-\d{2}-\d{2}$/.test(process.argv[3]) ? process.argv[3] : new Date().toISOString().slice(0, 10)).replace(/-/g, "");

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fld = (v: string, t: string) => {
  const m = new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, "i").exec(v);
  return m ? m[1].trim() : "";
};

(async () => {
  if (!WANT) { console.error("usage: tsx scripts/dump-voucher-by-number.ts <voucherNumber> [YYYY-MM-DD]"); process.exit(1); }
  const company = convertCompanies(await tallyPost(U, HEALTH_XML, 10_000))[0]!.name;

  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>MkDump</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="MkDump" ISMODIFY="No"><TYPE>Voucher</TYPE>
<NATIVEMETHOD>Date</NATIVEMETHOD><NATIVEMETHOD>VoucherNumber</NATIVEMETHOD>
<NATIVEMETHOD>VoucherTypeName</NATIVEMETHOD><NATIVEMETHOD>PartyLedgerName</NATIVEMETHOD>
<NATIVEMETHOD>PartyGSTIN</NATIVEMETHOD><NATIVEMETHOD>PlaceOfSupply</NATIVEMETHOD>
<NATIVEMETHOD>StateName</NATIVEMETHOD><NATIVEMETHOD>IsInvoice</NATIVEMETHOD>
<NATIVEMETHOD>AllLedgerEntries</NATIVEMETHOD><NATIVEMETHOD>AllInventoryEntries</NATIVEMETHOD>
<FILTER>MkDumpF</FILTER></COLLECTION>
<SYSTEM TYPE="Formulae" NAME="MkDumpF">($$YearOfDate:$Date * 10000 + $$MonthOfDate:$Date * 100 + $$DayOfDate:$Date) = ${DAY}</SYSTEM>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;

  const raw: string = await tallyPost(U, xml, 180_000, true);
  const v = [...raw.matchAll(/<VOUCHER\b[^>]*>[\s\S]*?<\/VOUCHER>/g)]
    .map((m) => m[0])
    .find((x) => fld(x, "VOUCHERNUMBER") === WANT);

  if (!v) { console.log(`\nNo voucher "${WANT}" on ${DAY}.\n`); process.exit(1); }

  // Which list elements does this voucher actually carry, and how many of each?
  console.log(`\n── element census ──`);
  for (const tag of [
    "LEDGERENTRIES.LIST", "ALLLEDGERENTRIES.LIST",
    "INVENTORYENTRIES.LIST", "ALLINVENTORYENTRIES.LIST",
    "ACCOUNTINGALLOCATIONS.LIST", "BILLALLOCATIONS.LIST", "BATCHALLOCATIONS.LIST",
  ]) {
    // The leading < and the exact name, so ALLLEDGERENTRIES is not counted as LEDGERENTRIES.
    const n = [...v.matchAll(new RegExp(`<${tag.replace(".", "\\.")}>`, "g"))].length;
    console.log(`  ${tag.padEnd(30)} ${n}`);
  }

  console.log(`\n── verbatim (${v.length} bytes) ──\n`);
  console.log(v);
})();
