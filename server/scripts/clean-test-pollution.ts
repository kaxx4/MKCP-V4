/**
 * Remove the vouchers this project's test harnesses pushed into the duplicate
 * company — and nothing else.
 *
 * Deletion is irreversible, so this runs in two modes. Without --delete it only
 * classifies and prints. Genuine vouchers can share today's date, so date alone
 * is never the test. A voucher is only ever treated as test data when its
 * voucher NUMBER matches a harness tag, or its narration carries a harness
 * marker. Anything that doesn't match is reported as "keeping" and left alone.
 *
 *   npx tsx scripts/clean-test-pollution.ts            # classify only
 *   npx tsx scripts/clean-test-pollution.ts --delete   # actually remove
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { convertCompanies } from "../src/converters/convert.js";
import { safePush } from "../src/services/safePush.js";
import type { VoucherPayload } from "../src/types.js";

const TALLY_URL = process.env.TALLY_URL || "http://localhost:9000";
const DELETE = process.argv.includes("--delete");

/**
 * Tags the harnesses in scripts/ generate, each `PREFIX + last-6-of-timestamp`:
 *   EC/E  test-edge-cases      AD  test-alter-delete     SO  test-so-to-invoice
 *   MR    mock-run-all         TS  test-tally-safety     BK  bulk/bank tests
 *   SIM   simulate-real-vouchers                         TEST generic
 * Anchored at the start and followed by digits, so a real reference such as
 * "TI/26-27/34" or "26-27/0637" can never match.
 */
const TEST_NUMBER = /^((EC|E|G|RT|AD|SO|MR|TS|BK|SIM|TEST)\d{5,}\b|(BULK|BANK)\/)/i;
const TEST_NARRATION = /\b(MOCK RUN|EDGE CASE|SIMULAT|TEST VOUCHER|ROUNDTRIP|SAFETY TEST)\b/i;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const unesc = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const fld = (b: string, t: string) => {
  const m = new RegExp(`<${t}[^>]*>([^<]*)</${t}>`).exec(b);
  return m ? unesc(m[1].replace(/&#\d+;/g, "").trim()) : "";
};
const lead = (s: string) => { const m = /^\s*(-?[\d.]+)/.exec(String(s).replace(/,/g, "")); return m ? parseFloat(m[1]) : 0; };
const inr = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");

async function healthy(): Promise<boolean> {
  try { return convertCompanies(await tallyPost(TALLY_URL, HEALTH_XML, 8_000)).length > 0; }
  catch { return false; }
}

/** Every voucher in the FY, so nothing hides outside a date window. */
async function allVouchers(company: string): Promise<string[]> {
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>ClnAll</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="ClnAll" ISMODIFY="No"><TYPE>Voucher</TYPE>
<NATIVEMETHOD>Date</NATIVEMETHOD><NATIVEMETHOD>VoucherNumber</NATIVEMETHOD>
<NATIVEMETHOD>VoucherTypeName</NATIVEMETHOD><NATIVEMETHOD>Narration</NATIVEMETHOD>
<NATIVEMETHOD>MasterId</NATIVEMETHOD><NATIVEMETHOD>PartyLedgerName</NATIVEMETHOD>
<NATIVEMETHOD>IsCancelled</NATIVEMETHOD>
<NATIVEMETHOD>AllLedgerEntries</NATIVEMETHOD><NATIVEMETHOD>LedgerEntries</NATIVEMETHOD>
</COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
  // The full-FY pull is ~229MB and takes over three minutes, so cache it between
  // a classify run and the delete run that follows it.
  const cache = "./.voucher-cache.xml";
  let raw: string;
  if (existsSync(cache) && !process.argv.includes("--refresh")) {
    raw = readFileSync(cache, "utf-8");
    console.log("(using cached voucher pull — pass --refresh to re-fetch)");
  } else {
    raw = await tallyPost(TALLY_URL, xml, 300_000, true);
    writeFileSync(cache, raw);
  }
  return [...raw.matchAll(/<VOUCHER\b[^>]*>[\s\S]*?<\/VOUCHER>/g)].map(x => x[0]);
}

/** Largest absolute ledger amount — a reasonable proxy for voucher size. */
function magnitude(v: string): number {
  const amts = [...v.matchAll(/<AMOUNT>([^<]*)<\/AMOUNT>/g)].map(m => Math.abs(lead(m[1])));
  return amts.length ? Math.max(...amts) : 0;
}

async function main() {
  const company = convertCompanies(await tallyPost(TALLY_URL, HEALTH_XML, 10_000))[0]?.name;
  if (!company) throw new Error("No company loaded");
  console.log(`company "${company}"\n`);

  const vs = await allVouchers(company);
  console.log(`${vs.length} vouchers in the company\n`);

  type Row = { num: string; type: string; party: string; narr: string; date: string; amt: number; why: string };
  const testRows: Row[] = [], keep: Row[] = [];
  for (const v of vs) {
    const num = fld(v, "VOUCHERNUMBER");
    const narr = fld(v, "NARRATION");
    const row: Row = {
      num, type: fld(v, "VOUCHERTYPENAME"), party: fld(v, "PARTYLEDGERNAME"),
      narr, date: fld(v, "DATE"), amt: magnitude(v), why: "",
    };
    if (TEST_NUMBER.test(num)) { row.why = "harness voucher number"; testRows.push(row); }
    else if (TEST_NARRATION.test(narr)) { row.why = "harness narration"; testRows.push(row); }
    else keep.push(row);
  }
  testRows.sort((a, b) => b.amt - a.amt);
  const testNums = new Set(testRows.map(r => r.num));

  console.log(`── CLASSIFIED AS TEST DATA — ${testRows.length} vouchers ──`);
  for (const r of testRows.slice(0, 25))
    console.log(`  ${r.num.padEnd(18)} ${r.type.slice(0, 10).padEnd(11)} ${r.party.slice(0, 28).padEnd(30)} ${inr(r.amt).padStart(14)}  ${r.date}`);
  if (testRows.length > 25) console.log(`  … and ${testRows.length - 25} more`);
  console.log(`  total magnitude: ${inr(testRows.reduce((s, r) => s + r.amt, 0))}`);

  // Show what today's date holds that is NOT being treated as test data, so a
  // genuine same-day voucher is visible rather than silently swept up.
  const todayStamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const keptToday = keep.filter(r => r.date === todayStamp && !testNums.has(r.num));
  console.log(`\n── KEEPING, though dated today — ${keptToday.length} vouchers ──`);
  // Census by number shape, so every same-day pattern gets examined deliberately
  // instead of a sample being eyeballed. Digits collapse to # so one line stands
  // for a whole family of generated numbers.
  const shape = (n: string) => n.replace(/\d+/g, "#");
  const census = new Map<string, { n: number; eg: string; amt: number }>();
  for (const r of keptToday) {
    const k = shape(r.num);
    const e = census.get(k) ?? { n: 0, eg: r.num, amt: 0 };
    e.n++; e.amt += r.amt; census.set(k, e);
  }
  for (const [k, e] of [...census.entries()].sort((a, b) => b[1].n - a[1].n))
    console.log(`  ${String(e.n).padStart(4)}×  ${k.padEnd(22)} e.g. ${e.eg.padEnd(20)} ${inr(e.amt).padStart(14)}`);
  if (!keptToday.length) console.log("  (none)");

  if (!DELETE) {
    console.log(`\nClassification only. Re-run with --delete to remove the ${testRows.length} test vouchers.`);
    return;
  }

  console.log(`\n── DELETING ${testRows.length} vouchers ──`);
  let gone = 0, stuck: string[] = [];
  for (const r of testRows) {
    // Delete addresses the voucher by REMOTEID; the harnesses used a small set of
    // stable key shapes, so try each against this voucher's type and number.
    const candidates = [
      `MKCP|${r.type}|${r.num}`,
      `MKCP|${r.type.replace(/\b\w/g, c => c.toUpperCase())}|${r.num}`,
      `MKCP|Purchase|${r.num}`, `MKCP|Sales|${r.num}`,
      `MKCP|Receipt|${r.num}`, `MKCP|Payment|${r.num}`, `MKCP|Order|${r.num}`,
    ];
    let removed = false;
    for (const remoteId of candidates) {
      const payload: VoucherPayload = {
        remoteId, action: "Delete",
        voucherType: (r.type as VoucherPayload["voucherType"]),
        date: `${r.date.slice(0, 4)}-${r.date.slice(4, 6)}-${r.date.slice(6, 8)}`,
        voucherNumber: r.num, partyLedgerName: r.party, isInvoice: false,
        ledgerEntries: [],
      };
      try {
        const res = await safePush(TALLY_URL, company, payload);
        if (res.ok || res.stage === "done") { removed = true; break; }
      } catch { /* try the next key shape */ }
    }
    if (removed) { gone++; process.stdout.write("."); }
    else stuck.push(r.num);
    if (!await healthy()) { console.log("\n⚠ Tally stopped answering — STOPPING."); break; }
  }
  console.log(`\n\n  removed ${gone} of ${testRows.length}`);
  if (stuck.length) {
    console.log(`  ${stuck.length} could not be addressed (created before REMOTEID was used — need deleting by hand in Tally):`);
    for (const n of stuck.slice(0, 20)) console.log(`    ${n}`);
    if (stuck.length > 20) console.log(`    … and ${stuck.length - 20} more`);
  }
  console.log(await healthy() ? "\n  Tally still healthy." : "\n  ⚠ Tally is NOT responding.");
}

main().catch(e => console.error("FAILED:", e.message));
