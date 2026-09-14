/**
 * Remove every voucher on a day whose number starts with a given prefix.
 *
 * Needed because "safePush returned ok:false" does NOT mean "nothing was
 * created". The read-back diff can reject a voucher that Tally accepted — an
 * Agst Ref silently rewritten to New Ref is exactly that case — so a cleanup
 * that only removes what the pusher reported as successful leaves the rest
 * behind. Sweep by what is actually in the books instead.
 *
 *   npx tsx scripts/sweep-test-vouchers.ts GSTV            # today
 *   npx tsx scripts/sweep-test-vouchers.ts GSTV 2026-09-11
 *   npx tsx scripts/sweep-test-vouchers.ts GSTV 2026-09-11 --delete
 */
import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { convertCompanies } from "../src/converters/convert.js";

const U = process.env.TALLY_URL || "http://localhost:9000";
const PREFIX = process.argv[2] ?? "GSTV";
const DAY = (process.argv[3] && /^\d{4}-\d{2}-\d{2}$/.test(process.argv[3]) ? process.argv[3] : new Date().toISOString().slice(0, 10)).replace(/-/g, "");
const DO = process.argv.includes("--delete");

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fld = (v: string, t: string) => {
  const m = new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, "i").exec(v);
  return m ? m[1].trim() : "";
};

(async () => {
  const company = convertCompanies(await tallyPost(U, HEALTH_XML, 10_000))[0]!.name;
  console.log(`\ncompany  "${company}"\nday      ${DAY}\nprefix   ${PREFIX}\n`);

  // Identity fields only — no entry blocks. A single day would be safe with
  // them, but nothing here needs them.
  const list = async () => {
    const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>MkSweep</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="MkSweep" ISMODIFY="No"><TYPE>Voucher</TYPE>
<NATIVEMETHOD>Date</NATIVEMETHOD><NATIVEMETHOD>VoucherNumber</NATIVEMETHOD>
<NATIVEMETHOD>VoucherTypeName</NATIVEMETHOD><NATIVEMETHOD>PartyLedgerName</NATIVEMETHOD>
<FILTER>MkSweepF</FILTER></COLLECTION>
<SYSTEM TYPE="Formulae" NAME="MkSweepF">($$YearOfDate:$Date * 10000 + $$MonthOfDate:$Date * 100 + $$DayOfDate:$Date) = ${DAY}</SYSTEM>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
    const raw: string = await tallyPost(U, xml, 180_000, true);
    return [...raw.matchAll(/<VOUCHER\b[^>]*>[\s\S]*?<\/VOUCHER>/g)]
      .map((x) => x[0])
      .filter((v) => fld(v, "VOUCHERNUMBER").startsWith(PREFIX));
  };

  const found = await list();
  if (!found.length) { console.log("Nothing matching. Books are clean.\n"); return; }

  for (const v of found) {
    console.log(`  ${fld(v, "VOUCHERTYPENAME").padEnd(18)} ${fld(v, "VOUCHERNUMBER").padEnd(20)} ${fld(v, "PARTYLEDGERNAME")}`);
  }
  if (!DO) { console.log(`\n${found.length} voucher(s). Pass --delete to remove them.\n`); return; }

  let gone = 0;
  for (const v of found) {
    const type = fld(v, "VOUCHERTYPENAME");
    const number = fld(v, "VOUCHERNUMBER");
    // The REMOTEID these were created with. Tally accepts no other handle.
    const remoteId = `MKCP|${type}|${number}|2026-27`;
    const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Import</TALLYREQUEST><TYPE>Data</TYPE><ID>Vouchers</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES></DESC>
<DATA><TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER REMOTEID="${esc(remoteId)}" VCHTYPE="${esc(type)}" ACTION="Delete"><DATE>${DAY}</DATE><VOUCHERTYPENAME>${esc(type)}</VOUCHERTYPENAME><VOUCHERNUMBER>${esc(number)}</VOUCHERNUMBER></VOUCHER></TALLYMESSAGE></DATA></BODY></ENVELOPE>`;
    const res: string = await tallyPost(U, xml, 60_000, true);
    const n = parseInt(fld(res, "DELETED") || "0", 10) || 0;
    console.log(`  ${n ? "\x1b[32m✓\x1b[0m removed" : "\x1b[31m✗\x1b[0m FAILED "} ${number}${n ? "" : ` — ${fld(res, "LINEERROR") || "no DELETED in response"}`}`);
    gone += n;
  }

  const left = await list();
  console.log(`\nremoved ${gone}, ${left.length} left.\n`);
  process.exit(left.length ? 1 : 0);
})();
