/**
 * Can a voucher created WITHOUT our REMOTEID ever be adopted?
 *
 * 39 Sales Order Notes already sit in Tally from before any of this, and the
 * orders view can only move an order it can address. Tally addresses a voucher
 * by a REMOTEID the caller assigned AT CREATION — everything else tested so far
 * has failed:
 *
 *   REMOTEID = the voucher's GUID ........ "Voucher does not exist!"
 *   VCHKEY attribute ..................... "Cannot delete unnamed object: VOUCHER!"
 *   <GUID> element with ACTION="Alter" .... silently performs a CREATE
 *
 * MASTERID has never been tried as a handle, and it is the obvious remaining
 * candidate: it is stable across alters and Tally exports it on every voucher.
 *
 * ── Why this is written so defensively ────────────────────────────────────
 * `ACTION="Alter"` WITHOUT a handle Tally recognises does not fail. It performs
 * a CREATE and returns created=1, which reads as success while duplicating real
 * financial data. So every probe here counts the vouchers before and after, and
 * treats "a second voucher appeared" as a FAILED adoption rather than a pass —
 * and deletes the duplicate, which is possible precisely because the duplicate
 * carries the REMOTEID the probe was trying to stamp.
 *
 * ⚠ COST, STATED UP FRONT: the subject voucher is created deliberately WITHOUT
 * a REMOTEID, to stand in for the 39 real ones. If no handle works it cannot be
 * deleted and becomes one more permanent voucher in the sandbox — the same trap
 * that stranded 296 of them. One voucher, ₹100, clearly tagged. The sandbox is
 * due to be re-duplicated from production anyway, which is the only reason this
 * is an acceptable price for the answer.
 *
 *   npx tsx scripts/explore-adopt-voucher.ts --push
 */
import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { convertCompanies } from "../src/converters/convert.js";
import { loadMasters, type TallyMasters } from "../src/services/tallyMasters.js";

const U = process.env.TALLY_URL || "http://localhost:9000";
const PUSH = process.argv.includes("--push");

const DATE = new Date().toISOString().slice(0, 10);
const STAMP = DATE.replace(/-/g, "");
const TAG = `ADOPT${Date.now().toString().slice(-5)}`;
const NUMBER = `${TAG}/SUBJECT`;
const WANTED_ID = `MKCP|Adopted|${NUMBER}|2026-27`;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fld = (v: string, t: string) => {
  const m = new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, "i").exec(v);
  return m ? m[1].trim() : "";
};

const healthy = async () => {
  try { return convertCompanies(await tallyPost(U, HEALTH_XML, 10_000)).length > 0; } catch { return false; }
};

async function vouchersNumbered(company: string, number: string): Promise<string[]> {
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>MkAdopt</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="MkAdopt" ISMODIFY="No"><TYPE>Voucher</TYPE>
<NATIVEMETHOD>Date</NATIVEMETHOD><NATIVEMETHOD>VoucherNumber</NATIVEMETHOD>
<NATIVEMETHOD>VoucherTypeName</NATIVEMETHOD><NATIVEMETHOD>Narration</NATIVEMETHOD>
<NATIVEMETHOD>Guid</NATIVEMETHOD><NATIVEMETHOD>MasterId</NATIVEMETHOD><NATIVEMETHOD>AlterId</NATIVEMETHOD>
<FILTER>MkAdoptF</FILTER></COLLECTION>
<SYSTEM TYPE="Formulae" NAME="MkAdoptF">($$YearOfDate:$Date * 10000 + $$MonthOfDate:$Date * 100 + $$DayOfDate:$Date) = ${STAMP}</SYSTEM>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
  const raw: string = await tallyPost(U, xml, 180_000, true);
  return [...raw.matchAll(/<VOUCHER\b[^>]*>[\s\S]*?<\/VOUCHER>/g)]
    .map((m) => m[0])
    .filter((v) => fld(v, "VOUCHERNUMBER") === number);
}

const post = (xml: string) => tallyPost(U, xml, 60_000, true) as Promise<string>;

/** A minimal, balanced Payment. Small and self-contained on purpose. */
function subjectXml(company: string, party: string, bank: string, remoteId?: string): string {
  const rid = remoteId ? ` REMOTEID="${esc(remoteId)}"` : "";
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Import</TALLYREQUEST><TYPE>Data</TYPE><ID>Vouchers</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES></DESC>
<DATA><TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER${rid} VCHTYPE="Payment" ACTION="Create">
<DATE>${STAMP}</DATE><VOUCHERTYPENAME>Payment</VOUCHERTYPENAME>
<VOUCHERNUMBER>${esc(NUMBER)}</VOUCHERNUMBER><ISINVOICE>No</ISINVOICE>
<NARRATION>${TAG} adoption subject — created with NO remote id</NARRATION>
<PARTYLEDGERNAME>${esc(party)}</PARTYLEDGERNAME>
<ALLLEDGERENTRIES.LIST><LEDGERNAME>${esc(party)}</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><ISPARTYLEDGER>Yes</ISPARTYLEDGER><AMOUNT>-100.00</AMOUNT></ALLLEDGERENTRIES.LIST>
<ALLLEDGERENTRIES.LIST><LEDGERNAME>${esc(bank)}</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><ISPARTYLEDGER>No</ISPARTYLEDGER><AMOUNT>100.00</AMOUNT></ALLLEDGERENTRIES.LIST>
</VOUCHER></TALLYMESSAGE></DATA></BODY></ENVELOPE>`;
}

/** One adoption attempt: Alter via `handleAttrs`, stamping WANTED_ID. */
function adoptXml(company: string, handleAttrs: string, inner: string): string {
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Import</TALLYREQUEST><TYPE>Data</TYPE><ID>Vouchers</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES></DESC>
<DATA><TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER REMOTEID="${esc(WANTED_ID)}"${handleAttrs} VCHTYPE="Payment" ACTION="Alter">
<DATE>${STAMP}</DATE><VOUCHERTYPENAME>Payment</VOUCHERTYPENAME>
<VOUCHERNUMBER>${esc(NUMBER)}</VOUCHERNUMBER><ISINVOICE>No</ISINVOICE>
<NARRATION>${TAG} ADOPTED</NARRATION>${inner}
</VOUCHER></TALLYMESSAGE></DATA></BODY></ENVELOPE>`;
}

async function deleteBy(company: string, remoteId: string): Promise<number> {
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Import</TALLYREQUEST><TYPE>Data</TYPE><ID>Vouchers</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES></DESC>
<DATA><TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER REMOTEID="${esc(remoteId)}" VCHTYPE="Payment" ACTION="Delete"><DATE>${STAMP}</DATE><VOUCHERTYPENAME>Payment</VOUCHERTYPENAME><VOUCHERNUMBER>${esc(NUMBER)}</VOUCHERNUMBER></VOUCHER></TALLYMESSAGE></DATA></BODY></ENVELOPE>`;
  return parseInt(fld(await post(xml), "DELETED") || "0", 10) || 0;
}

(async () => {
  const company = convertCompanies(await tallyPost(U, HEALTH_XML, 10_000))[0]!.name;
  const m: TallyMasters = await loadMasters(U, company);
  const party = [...m.ledgers.values()].find((l) => /SUNDRY CREDITORS/i.test(l.parent))!;

  console.log(`\n\x1b[1mCan a voucher with no assigned REMOTEID be adopted?\x1b[0m\n`);
  console.log(`company  "${company}"`);
  console.log(`subject  ${NUMBER} — a ₹100 Payment to ${party.name}, created with NO remote id`);
  console.log(`goal     stamp it with ${WANTED_ID} so it becomes addressable`);
  console.log(`\n⚠ If no handle works the subject CANNOT be deleted and stays in the sandbox.`);

  if (!PUSH) { console.log(`\nDry run. Pass --push to actually try.\n`); return; }

  // ── Create the subject ──────────────────────────────────────────────────
  const created = await post(subjectXml(company, party.name, "HDFC BANK"));
  const madeOk = (parseInt(fld(created, "CREATED") || "0", 10) || 0) === 1;
  console.log(`\ncreated  ${madeOk ? "yes" : `NO — ${fld(created, "LINEERROR")}`}`);
  if (!madeOk) process.exit(1);

  let found = await vouchersNumbered(company, NUMBER);
  const guid = fld(found[0] ?? "", "GUID");
  const masterId = fld(found[0] ?? "", "MASTERID");
  console.log(`         GUID ${guid}`);
  console.log(`         MASTERID ${masterId}`);

  // ── The candidate handles, one at a time ────────────────────────────────
  const candidates: Array<{ name: string; attrs: string; inner: string }> = [
    { name: "MASTERID attribute", attrs: ` MASTERID="${esc(masterId)}"`, inner: "" },
    { name: "MASTERID element", attrs: "", inner: `\n<MASTERID>${esc(masterId)}</MASTERID>` },
    { name: "VOUCHERKEY element", attrs: "", inner: `\n<VOUCHERKEY>${esc(guid)}</VOUCHERKEY>` },
    { name: "no handle at all (control)", attrs: "", inner: "" },
  ];

  let adopted: string | null = null;

  for (const c of candidates) {
    if (adopted) break;
    console.log(`\n── ${c.name}`);
    const before = (await vouchersNumbered(company, NUMBER)).length;

    let res = "";
    try { res = await post(adoptXml(company, c.attrs, c.inner)); }
    catch (e) { console.log(`   transport: ${(e as Error).message.slice(0, 90)}`); }

    const lineError = fld(res, "LINEERROR");
    const altered = parseInt(fld(res, "ALTERED") || "0", 10) || 0;
    const madeNew = parseInt(fld(res, "CREATED") || "0", 10) || 0;

    const after = await vouchersNumbered(company, NUMBER);
    const grew = after.length > before;
    const narrations = after.map((v) => fld(v, "NARRATION"));
    const stamped = narrations.filter((n) => /ADOPTED/.test(n)).length;

    console.log(`   response   altered=${altered} created=${madeNew}${lineError ? ` lineError="${lineError}"` : ""}`);
    console.log(`   vouchers   ${before} → ${after.length}${grew ? "  \x1b[31m(a DUPLICATE appeared)\x1b[0m" : ""}`);

    if (!grew && stamped > 0 && after.length === before) {
      console.log(`   \x1b[32m✓ ADOPTED\x1b[0m — altered in place, no duplicate`);
      adopted = c.name;
    } else if (grew) {
      // The duplicate carries WANTED_ID, so it is deletable — unlike the
      // subject. Remove it before trying the next handle.
      const gone = await deleteBy(company, WANTED_ID);
      console.log(`   \x1b[31m✗ not adoption\x1b[0m — it created a duplicate; removed ${gone}`);
    } else {
      console.log(`   \x1b[31m✗ rejected\x1b[0m — nothing changed`);
    }

    if (!await healthy()) { console.log(`\n⚠ Tally stopped answering after "${c.name}". STOPPING.`); break; }
  }

  // ── Clean up what we can ────────────────────────────────────────────────
  console.log(`\n── cleaning up`);
  const gone = await deleteBy(company, WANTED_ID);
  const left = await vouchersNumbered(company, NUMBER);
  console.log(`   deleted ${gone} by the stamped id; ${left.length} left`);

  console.log(`\n\x1b[1m${adopted ? `ADOPTION WORKS via ${adopted}` : "NO HANDLE ADOPTS AN EXISTING VOUCHER"}\x1b[0m`);
  if (!adopted && left.length) {
    console.log(`The subject (${NUMBER}) is now permanent — exactly the trap that stranded 296 vouchers.`);
  }
  console.log(`\nTally ${(await healthy()) ? "still healthy" : "\x1b[31mNOT ANSWERING\x1b[0m"}.\n`);
})();
