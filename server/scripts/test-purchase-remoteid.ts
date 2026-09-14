/**
 * Can a purchase voucher from the WEB APP's builder be corrected after it lands?
 *
 * Until now it could not. `engine/purchase/buildXml.ts` emitted no REMOTEID, and
 * Tally addresses an existing voucher only by a REMOTEID the caller assigned at
 * creation — so every purchase this app has ever generated is permanent.
 *
 * This is the Stage 1 proof: "a purchase voucher pushed THEN ALTERED by
 * REMOTEID". It deliberately runs against XML emitted by the real web builder
 * rather than a hand-built lookalike, because that seam — two sides whose
 * fixtures were each written by hand — is exactly where this codebase's dead
 * features have hidden.
 *
 *   1. emit v1 from the builder (₹10,000) and import it
 *   2. read back: one voucher, at v1's total
 *   3. emit v2 (₹13,500), same voucher number, switch ACTION to Alter, import
 *   4. read back: STILL ONE voucher, now at v2's total — not two
 *   5. delete it by the same REMOTEID, and confirm it is gone
 *
 * Usage (the XML files come from web-dashboard/emit-purchase-xml.mts):
 *   npx tsx scripts/test-purchase-remoteid.ts <v1.xml> <v2.xml>
 */
import { readFileSync } from "node:fs";
import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { convertCompanies } from "../src/converters/convert.js";

const TALLY_URL = process.env.TALLY_URL || "http://localhost:9000";
const [, , V1_PATH, V2_PATH] = process.argv;
const DATE = "2026-07-20";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fld = (xml: string, tag: string) => {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(xml);
  return m ? m[1].trim() : "";
};

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

async function vouchersOn(company: string, iso: string): Promise<string[]> {
  const stamp = parseInt(iso.replace(/-/g, ""), 10);
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>RidVerify</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="RidVerify" ISMODIFY="No"><TYPE>Voucher</TYPE>
<NATIVEMETHOD>Date</NATIVEMETHOD><NATIVEMETHOD>VoucherNumber</NATIVEMETHOD>
<NATIVEMETHOD>VoucherTypeName</NATIVEMETHOD><NATIVEMETHOD>MasterId</NATIVEMETHOD>
<NATIVEMETHOD>PartyLedgerName</NATIVEMETHOD><NATIVEMETHOD>AllLedgerEntries</NATIVEMETHOD>
<FILTER>RidVerifyDate</FILTER></COLLECTION>
<SYSTEM TYPE="Formulae" NAME="RidVerifyDate">($$YearOfDate:$Date * 10000 + $$MonthOfDate:$Date * 100 + $$DayOfDate:$Date) = ${stamp}</SYSTEM>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
  const raw: string = await tallyPost(TALLY_URL, xml, 240_000, true);
  return [...raw.matchAll(/<VOUCHER\b[^>]*>[\s\S]*?<\/VOUCHER>/g)].map((x) => x[0]);
}

/** The party line's amount is the voucher's grand total (negative = credit). */
const partyAmount = (v: string) => {
  const amounts = [...v.matchAll(/<AMOUNT[^>]*>\s*(-?[\d.]+)\s*<\/AMOUNT>/gi)].map((m) => parseFloat(m[1]));
  return amounts.length ? Math.max(...amounts.map(Math.abs)) : 0;
};

const importXml = (xml: string) => tallyPost(TALLY_URL, xml, 60_000, true) as Promise<string>;
const verdict = (raw: string) => ({
  created: parseInt(fld(raw, "CREATED") || "0", 10),
  altered: parseInt(fld(raw, "ALTERED") || "0", 10),
  deleted: parseInt(fld(raw, "DELETED") || "0", 10),
  errors: parseInt(fld(raw, "ERRORS") || "0", 10),
  lineError: fld(raw, "LINEERROR"),
});

(async () => {
  if (!V1_PATH || !V2_PATH) {
    console.error("usage: tsx scripts/test-purchase-remoteid.ts <v1.xml> <v2.xml>");
    process.exit(1);
  }
  const company = convertCompanies(await tallyPost(TALLY_URL, HEALTH_XML, 10_000))[0]!.name;
  console.log(`\nPurchase REMOTEID — push, then correct\n\ncompany  "${company}"`);

  const v1 = readFileSync(V1_PATH, "utf8");
  const v2 = readFileSync(V2_PATH, "utf8");

  const rid = /REMOTEID="([^"]*)"/.exec(v1)?.[1] ?? "";
  const number = fld(v1, "VOUCHERNUMBER");
  check("the builder stamped a REMOTEID", Boolean(rid), rid);
  check("both versions share it", rid === (/REMOTEID="([^"]*)"/.exec(v2)?.[1] ?? ""), "same document, same identity");

  const mine = async () => (await vouchersOn(company, DATE)).filter((v) => fld(v, "VOUCHERNUMBER") === number);
  const before = (await mine()).length;

  try {
    // ── 1. Create ────────────────────────────────────────────────────────────
    console.log("\ncreating");
    const c = verdict(await importXml(v1));
    check("Tally created it", c.created === 1 && c.errors === 0, c.lineError || `created=${c.created}`);

    let found = await mine();
    check("exactly one voucher exists", found.length === before + 1, `${found.length} with number ${number}`);
    const firstMasterId = fld(found[0] ?? "", "MASTERID");
    check("it carries v1's amount — ₹10,500", Math.abs(partyAmount(found[0] ?? "") - 10_500) < 1,
          `₹${partyAmount(found[0] ?? "").toFixed(2)}`);

    // ── 2. Alter, addressed ONLY by the REMOTEID ─────────────────────────────
    console.log("\ncorrecting the amount, addressed by REMOTEID alone");
    const a = verdict(await importXml(v2.replace('ACTION="Create"', 'ACTION="Alter"')));
    check("Tally altered it", a.altered === 1 && a.errors === 0, a.lineError || `altered=${a.altered} created=${a.created}`);
    check("it did NOT create a second voucher", a.created === 0, `created=${a.created}`);

    found = await mine();
    check("STILL exactly one voucher", found.length === before + 1, `${found.length} with number ${number}`);
    check("the correction is what is stored — ₹14,175", Math.abs(partyAmount(found[0] ?? "") - 14_175) < 1,
          `₹${partyAmount(found[0] ?? "").toFixed(2)}`);
    check("the same voucher, not a replacement", fld(found[0] ?? "", "MASTERID") === firstMasterId,
          `MASTERID ${firstMasterId} unchanged`);
  } finally {
    // ── 3. Remove it, by the same handle ─────────────────────────────────────
    console.log("\ncleaning up");
    const del = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Import</TALLYREQUEST><TYPE>Data</TYPE><ID>Vouchers</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES></DESC>
<DATA><TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER REMOTEID="${rid}" VCHTYPE="Purchase" ACTION="Delete"><DATE>${DATE.replace(/-/g, "")}</DATE><VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME><VOUCHERNUMBER>${esc(number)}</VOUCHERNUMBER></VOUCHER></TALLYMESSAGE></DATA></BODY></ENVELOPE>`;
    const d = verdict(await importXml(del));
    const left = (await vouchersOn(company, DATE)).filter((v) => fld(v, "VOUCHERNUMBER") === number).length;
    check("deleted by the same REMOTEID", left === before, `deleted=${d.deleted}, ${left} left (started at ${before})`);
  }

  console.log(`\n${failures === 0 ? "PASS" : `FAIL — ${failures} check(s) failed`}\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
