/**
 * Every test voucher still in the books, and whether it can be removed from here.
 *
 * ── Why ───────────────────────────────────────────────────────────────────
 *
 * Harnesses on this project have left vouchers behind. Some carry a REMOTEID
 * and can be deleted over XML; the ones written before G5 was enforced carry no
 * handle at all, and **no handle adopts a voucher after the fact** — MASTERID,
 * VOUCHERKEY, GUID and VCHKEY were all tried against the live company on
 * 19-Sep-2026 and every one returned `altered=0 created=0`
 * (`explore-adopt-voucher.ts`). Those can only be deleted by a human in the
 * Tally UI.
 *
 * "Needs a human" is a much smaller ask when it comes with the exact list. This
 * prints one, sorted by date, with the Tally navigation spelled out — and it
 * separates the ones IT can remove from the ones it cannot, rather than lumping
 * them together.
 *
 * ── Safety ────────────────────────────────────────────────────────────────
 *
 * Read-only unless `--delete`, and even then it only attempts vouchers whose
 * REMOTEID it can reconstruct from a known producer's convention. The pull is
 * the TRIMMED voucher shape (number, type, date, narration, party) — the full
 * shape is 229 MB and 201 s and wedges Tally; this one is ~4 MB.
 *
 *   npx tsx server/scripts/find-stranded-test-vouchers.ts            (list)
 *   npx tsx server/scripts/find-stranded-test-vouchers.ts --delete   (remove what it can)
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
config({ path: join(dirname(fileURLToPath(import.meta.url)), "..", ".env") });

import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { convertCompanies } from "../src/converters/convert.js";
import { esc, blocksOf, tagOf } from "../src/services/tallyRequest.js";

const U = process.env.TALLY_URL || "http://localhost:9000";
const DO = process.argv.includes("--delete");

/**
 * What marks a voucher as ours-and-disposable.
 *
 * The patterns are the EXACT formats the harnesses emit, and that precision is
 * not fussiness. The first version of this file matched the bare prefix
 * `MKCP-`, and on 19-Sep-2026 that flagged nine REAL purchase vouchers —
 * `MKCP-01` … `MKCP-09`, MONDAL ENTERPRISE, bicycle baskets, 1.16–1.76 lakh
 * each, roughly 14 lakh of genuine trade, each carrying the supplier's own bill
 * number in REFERENCE. `MKCP-` is a real supplier bill SERIES in these books.
 * Had `--delete` run against that list it would have destroyed a year of
 * purchases from one supplier.
 *
 * So: match the full harness shape (`MKCP-` + two letters + digits), never a
 * bare prefix, and never a loose keyword like "test" — a real voucher could say
 * that, and the cost of a false positive here is somebody's invoice.
 *
 * `--delete` also refuses anything that does not match a pattern, rather than
 * trusting the listing it printed a moment ago.
 */
const NUMBER_PATTERNS: RegExp[] = [
  /^MKCP-[A-Z]{2}\d{4,}/i,   // MKCP-QP90313-1, MKCP-VT12345-1
  /^RT\d{5,}\//i,            // RT741351/S
  /^ADOPT\d+\//i,            // ADOPT61309/SUBJECT
  /^ZZTEST\//i,
  /^GSTV\d*\//i,
  /^PROBE[-/]/i,
  /^FID[-/]/i,
];
const NARRATION_MARKS = [
  "delete if this survives", "round-trip harness", "roundtrip harness",
  "probe. delete", "harness. delete",
];

/** REMOTEID spellings the harnesses have used, newest first. */
const remoteIdGuesses = (type: string, number: string) => [
  `MKCP|${type}|${number}|2026-27`,
  `MKCP-RT|${type}|${number}`,
  `MKCP|QuotePrice|${number}|2026-27`,
  `MKCP|TypeProbe|${number}|2026-27`,
];

async function pull(company: string) {
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>StrandScan</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="StrandScan" ISMODIFY="No"><TYPE>Voucher</TYPE>
<NATIVEMETHOD>DATE</NATIVEMETHOD><NATIVEMETHOD>VOUCHERNUMBER</NATIVEMETHOD>
<NATIVEMETHOD>VOUCHERTYPENAME</NATIVEMETHOD><NATIVEMETHOD>PARTYLEDGERNAME</NATIVEMETHOD>
<NATIVEMETHOD>NARRATION</NATIVEMETHOD><NATIVEMETHOD>ISCANCELLED</NATIVEMETHOD>
</COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
  const raw = await tallyPost(U, xml, 300_000, true) as string;
  return blocksOf(raw, "VOUCHER")
    .map((v) => ({
      date: (tagOf(v, "DATE") ?? "").trim(),
      number: (tagOf(v, "VOUCHERNUMBER") ?? "").trim(),
      type: (tagOf(v, "VOUCHERTYPENAME") ?? "").trim(),
      party: (tagOf(v, "PARTYLEDGERNAME") ?? "").trim(),
      narration: (tagOf(v, "NARRATION") ?? "").trim(),
      cancelled: /yes/i.test((tagOf(v, "ISCANCELLED") ?? "").trim()),
    }))
    .filter((v) => v.type);
}

async function tryDelete(company: string, type: string, number: string, date: string) {
  for (const remoteId of remoteIdGuesses(type, number)) {
    const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Import</TALLYREQUEST><TYPE>Data</TYPE><ID>Vouchers</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES></DESC>
<DATA><TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER REMOTEID="${esc(remoteId)}" VCHTYPE="${esc(type)}" ACTION="Delete">
<DATE>${date}</DATE><VOUCHERTYPENAME>${esc(type)}</VOUCHERTYPENAME><VOUCHERNUMBER>${esc(number)}</VOUCHERNUMBER></VOUCHER>
</TALLYMESSAGE></DATA></BODY></ENVELOPE>`;
    try {
      const res = await tallyPost(U, xml, 120_000, true) as string;
      if ((/<DELETED>(\d+)<\/DELETED>/.exec(res)?.[1] ?? "0") !== "0") return remoteId;
    } catch { /* "Voucher does not exist!" — wrong guess, try the next */ }
  }
  return null;
}

(async () => {
  const company = convertCompanies(await tallyPost(U, HEALTH_XML, 10_000))[0]!.name;
  console.log(`\n  STRANDED TEST VOUCHERS\n  ${company}`);
  console.log(`  role=${process.env.MKCP_TALLY_ROLE ?? "primary"}\n  ${"─".repeat(72)}`);

  const all = await pull(company);
  const isOurs = (v: { number: string; narration: string }) =>
    NUMBER_PATTERNS.some((re) => re.test(v.number))
    || NARRATION_MARKS.some((m) => v.narration.toLowerCase().includes(m));
  const suspect = all.filter(isOurs);

  console.log(`  ${all.length} vouchers scanned · ${suspect.length} look like ours\n`);
  if (!suspect.length) { console.log(`  Nothing stranded. Books are clean.\n`); return; }

  suspect.sort((a, b) => a.date.localeCompare(b.date));
  for (const v of suspect) {
    console.log(`  ${v.date.padEnd(12)} ${v.type.padEnd(18)} ${v.number.padEnd(22)} ${v.party.slice(0, 26)}${v.cancelled ? "  [cancelled]" : ""}`);
  }

  if (!DO) { console.log(`\n  Listing only — pass --delete to remove the ones that carry a handle.\n`); return; }

  console.log(`\n  ── attempting deletion (REMOTEID is the ONLY handle Tally accepts)`);
  const stuck: typeof suspect = [];
  for (const v of suspect) {
    /* Re-check rather than trust the list printed a moment ago. Cheap, and the
       thing it guards against is deleting a real voucher. */
    if (!isOurs(v)) { console.log(`     SKIP     ${v.number}   does not match a harness pattern`); continue; }
    const via = await tryDelete(company, v.type, v.number, v.date.replace(/-/g, ""));
    if (via) console.log(`     removed  ${v.number}   via ${via}`);
    else { console.log(`     STUCK    ${v.number}   no reconstructable REMOTEID`); stuck.push(v); }
  }

  if (!stuck.length) { console.log(`\n  All removed. Books are clean.\n`); return; }

  console.log(`\n  ${"═".repeat(72)}`);
  console.log(`  ${stuck.length} voucher(s) CANNOT be deleted from here, and no future script`);
  console.log(`  will manage it either: they were written without a REMOTEID, and MASTERID,`);
  console.log(`  VOUCHERKEY, GUID and VCHKEY were all tried against the live company on`);
  console.log(`  19-Sep-2026 — every one returned altered=0 created=0.`);
  console.log(`\n  In TallyPrime:  Gateway of Tally → Display More Reports → Day Book`);
  console.log(`                  → F2 set the date → select the row → Alt+D → Yes\n`);
  for (const v of stuck) {
    console.log(`     ${v.date.padEnd(12)} ${v.type.padEnd(18)} ${v.number.padEnd(22)} ${v.party.slice(0, 26)}`);
  }
  console.log();
})();
