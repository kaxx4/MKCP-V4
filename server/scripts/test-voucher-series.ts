/**
 * Task 1-4, offline: the voucher-number rule and the REMOTEID rule on the agent.
 *
 * 1. `contracts/voucher-series.json`, the cases the database (migration 0113,
 *    live test 1-4_counter.sql) and the web app also run: format, parse, the
 *    financial year, and India's date at 31-Mar 23:59, 1-Apr 00:01 and 05:29.
 *    The copy here must be byte-identical to the web repo's, checked when the
 *    web repo sits beside this one.
 * 2. `remoteIdFor` never builds an id with nothing unique after the type, and
 *    two unnumbered journals keyed on their jobs get two ids.
 * 3. pushGuard refuses a Create whose REMOTEID has no unique part, and an ERP
 *    counter number under a REMOTEID that does not carry it.
 *
 * Run it in India time and in UTC (the 1-April cases must not move):
 *   npx tsx scripts/test-voucher-series.ts
 *   $env:TZ='UTC'; npx tsx scripts/test-voucher-series.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { formatSeriesNumber, seriesCounter, indiaDateOf, isErpSeriesNumber, seriesDefaultFor, sameVoucherNumber, numberTakenBy, isPartyKeyedType } from "../src/services/voucherSeries.js";
import { assertCollectionReply, takenNumbersOrThrow, takenVouchersOrThrow, parseTakenVouchers } from "../src/services/voucherNumbering.js";
import { withCounterOverride } from "../src/services/erpJobAgent.js";
import { resolveWebDir } from "./guardrails/lib.js";
import { financialYearOf, remoteIdFor, remoteIdHasUniquePart } from "../src/services/remoteId.js";
import { guardVoucher } from "../src/services/pushGuard.js";
import { fixtureMasters } from "./guardrails/fixtures.js";
import type { VoucherPayload } from "../src/types.js";

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? `: ${detail}` : ""}`); }
};

const here = __dirname;
const mine = join(here, "..", "contracts", "voucher-series.json");
const fx = JSON.parse(readFileSync(mine, "utf8"));
console.log(`\n  Voucher numbers and REMOTEIDs, offline (task 1-4), TZ=${process.env.TZ ?? "(machine)"}\n`);

// 1. the shared contract
for (const c of fx.format) {
  const got = formatSeriesNumber(c.template, c.fy, c.n, c.width);
  ok(`format ${c.template} ${c.fy} ${c.n} is ${c.number}`, got === c.number, got);
}
for (const c of fx.parse) {
  const got = seriesCounter(c.number, c.template, c.fy);
  ok(`parse "${c.number}" in ${c.template} ${c.fy} is ${c.counter}`, got === c.counter, String(got));
}
for (const c of fx.financialYear) ok(`financial year of ${c.date} is ${c.fy}`, financialYearOf(c.date) === c.fy);
for (const c of fx.indiaDate) {
  const d = indiaDateOf(c.at);
  ok(`India's date at ${c.ist} is ${c.date}, financial year ${c.fy}`, d === c.date && financialYearOf(d) === c.fy, `${d} ${financialYearOf(d)}`);
}
/* Review L3: the web copy is found through the one resolver (MKCP_WEB_DIR, else
   the sibling checkout), never a hard-coded lane folder. Not finding it is a
   FAIL when CI or MKCP_WEB_DIR says the web repo should be there; otherwise a
   loud skip, which is not a pass. */
const web = join(resolveWebDir(), "contracts", "voucher-series.json");
const mustFind = Boolean(process.env.CI || process.env.MKCP_WEB_DIR || process.env.MKCP_REQUIRE_WEB_CONTRACT);
const lf = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
if (existsSync(web)) ok(`the contract here is byte-identical to the web repo's (${web})`, lf(web) === lf(mine));
else if (mustFind) ok(`the web repo's contract was found at ${web}`, false, "set MKCP_WEB_DIR to its web-dashboard folder");
else console.log(`  (web contract not found at ${web}: byte check SKIPPED, not a pass; set MKCP_WEB_DIR)`);

// review L2: compare by the counter where a series applies
for (const c of fx.sameNumber) {
  const got = sameVoucherNumber(c.a, c.b, c.type, c.fy);
  ok(`same number? "${c.a}" and "${c.b}" (${c.type} ${c.fy}) is ${c.same}`, got === c.same, String(got));
}

// the series table
ok("Sales continues Tally's series, seeded from Tally's highest", seriesDefaultFor("SALES")?.template === "{FY}/{N}" && seriesDefaultFor("Sales")?.seedSource === "tally_highest");
ok("Payment, Receipt, Contra, Journal and Stock Journal use the ERP prefix, seeded from the ERP's own highest",
  ["Payment", "Receipt", "Contra", "Journal", "Stock Journal"].every((t) => seriesDefaultFor(t)?.template === "ERP-{N}/{FY}" && seriesDefaultFor(t)?.seedSource === "erp_own"));
ok("Purchase is never numbered by the ERP (the supplier's bill number)", seriesDefaultFor("Purchase") === null);
ok("ERP-12/26-27 is an ERP Payment number in 2026-27; 1853/26-27 is not", isErpSeriesNumber("ERP-12/26-27", "Payment", "2026-11-05") && !isErpSeriesNumber("1853/26-27", "Payment", "2026-11-05"));
ok("a Sales number is never ours by its shape (it shares Tally's series)", !isErpSeriesNumber("26-27/0900", "Sales", "2026-11-05"));

// 2. REMOTEID
ok("an unnumbered journal with no job gets NO id (never MKCP|Journal|2026-27)", remoteIdFor({ voucherType: "Journal", voucherNumber: "", date: "2026-11-05" }) === "");
const j1 = remoteIdFor({ voucherType: "Journal", voucherNumber: "", date: "2026-11-05", jobId: "11111111-1111-1111-1111-111111111111" });
const j2 = remoteIdFor({ voucherType: "Journal", voucherNumber: "", date: "2026-11-05", jobId: "22222222-2222-2222-2222-222222222222" });
ok("catalogue: two unnumbered journals keyed on their jobs get two ids, so they make two vouchers", j1 !== j2 && remoteIdHasUniquePart(j1) && remoteIdHasUniquePart(j2), `${j1} / ${j2}`);
ok("a numbered voucher keeps the id it always had (the job id is ignored)",
  remoteIdFor({ voucherType: "Payment", voucherNumber: "ERP-7/26-27", date: "2026-11-05", jobId: "x" }) === "MKCP|Payment|ERP-7/26-27|2026-27");
ok("the unique-part rule", !remoteIdHasUniquePart("MKCP|Journal|2026-27") && !remoteIdHasUniquePart("MKCP|Journal") && !remoteIdHasUniquePart("")
  && remoteIdHasUniquePart("MKCP|Sales|26-27/0900|2026-27") && remoteIdHasUniquePart("ZZTEST-13-R1") && remoteIdHasUniquePart("MKCP|GUARD|Receipt|0923|x"));

// 3. pushGuard
const base = (over: Partial<VoucherPayload>): VoucherPayload => ({
  voucherType: "Journal", date: "2026-11-05", voucherNumber: "ERP-3/26-27", remoteId: "MKCP|Journal|ERP-3/26-27|2026-27",
  narration: "ZZTEST 1-4", partyLedgerName: "Cash", isInvoice: false,
  ledgerEntries: [
    { ledgerName: "Cash", amount: 10, isDeemedPositive: true, isPartyLedger: false },
    { ledgerName: "HDFC BANK", amount: 10, isDeemedPositive: false, isPartyLedger: false },
  ],
  ...over,
} as VoucherPayload);
const masters = fixtureMasters();
const errs = (p: VoucherPayload) => guardVoucher(p, masters).errors.join(" | ");
ok("pushGuard refuses a Create whose REMOTEID has nothing unique after the type",
  /nothing unique after the voucher type/.test(errs(base({ voucherNumber: "", remoteId: "MKCP|Journal|2026-27" }))), errs(base({ voucherNumber: "", remoteId: "MKCP|Journal|2026-27" })));
ok("pushGuard refuses an ERP counter number under a REMOTEID that does not carry it",
  /does not carry it/.test(errs(base({ remoteId: "MKCP|Journal|ERP-4/26-27|2026-27" }))));
ok("pushGuard lets a counter-numbered Create with its own REMOTEID through these two rules",
  !/nothing unique|does not carry it/.test(errs(base({}))), errs(base({})));
ok("a Sales Create keyed on its number passes the unique-part rule",
  !/nothing unique/.test(errs(base({ voucherType: "Sales", voucherNumber: "26-27/0900", remoteId: "MKCP|Sales|26-27/0900|2026-27" }))));

// review H1: which Creates are number-checked, and how
{
  const pur = (party: string, number = "INV-77", date = "2026-11-05") => ({ voucherType: "Purchase", voucherNumber: number, partyLedgerName: party, date });
  const tally = [{ number: "INV-77", party: "ZZ TEST SUPPLIER A", date: "2026-10-01" }];
  ok("H1 Purchase and Debit Note are party-keyed; Payment is not", isPartyKeyedType("Purchase") && isPartyKeyedType("debit note") && !isPartyKeyedType("Payment"));
  ok("H1 two suppliers may share one bill number: supplier B's INV-77 is free", numberTakenBy(pur("ZZ TEST SUPPLIER B"), tally) === null);
  ok("H1 the same supplier repeating its own number is taken (any case, extra spaces)", numberTakenBy(pur(" zz test  supplier a "), tally) === "INV-77");
  ok("H1 the same supplier's number from LAST year is free this year", numberTakenBy(pur("ZZ TEST SUPPLIER A"), [{ number: "INV-77", party: "ZZ TEST SUPPLIER A", date: "2026-03-30" }]) === null);
  ok("H1 a Tally row with no party cannot be told apart, so it counts as taken", numberTakenBy(pur("ZZ TEST SUPPLIER B"), [{ number: "INV-77", party: null, date: "2026-10-01" }]) === "INV-77");
  ok("H1 a type the ERP never numbers (Credit Note) is not checked here", numberTakenBy({ voucherType: "Credit Note", voucherNumber: "CN-1", date: "2026-11-05" }, ["CN-1"]) === null);
  ok("L2 ERP-05/26-27 in Tally blocks the counter's ERP-5/26-27", numberTakenBy({ voucherType: "Contra", voucherNumber: "ERP-5/26-27", date: "2026-11-05" }, ["ERP-05/26-27"]) === "ERP-05/26-27");
  ok("L2 erp-5/26-27 typed in lower case blocks ERP-5/26-27", numberTakenBy({ voucherType: "Payment", voucherNumber: "ERP-5/26-27", date: "2026-11-05" }, ["erp-5/26-27"]) === "erp-5/26-27");
  ok("L2 26-27/903 blocks the Sales number 26-27/0903", numberTakenBy({ voucherType: "Sales", voucherNumber: "26-27/0903", date: "2026-11-05" }, ["26-27/903"]) === "26-27/903");
  const pay = { voucherType: "Payment", voucherNumber: "ERP-3/26-27" } as VoucherPayload;
  ok("H1 the push pins a counter number (override) on Payment", withCounterOverride(pay).numberOverride === true);
  ok("H1 the push never pins a Purchase bill number", withCounterOverride({ ...pay, voucherType: "Purchase" }).numberOverride !== true);
  ok("H1 nor a Journal's (Tally keeps no number on one here)", withCounterOverride({ ...pay, voucherType: "Journal" }).numberOverride !== true);
}

// review M3: "could not look" is never "free"
async function m3() {
  const valid = (body: string) => `<ENVELOPE><HEADER><VERSION>1</VERSION><STATUS>1</STATUS></HEADER><BODY><DESC></DESC><DATA><COLLECTION>${body}</COLLECTION></DATA></BODY></ENVELOPE>`;
  const throws = (res: unknown) => { try { assertCollectionReply(res); return false; } catch { return true; } };
  ok("M3 a LINEERROR reply throws", throws(`<ENVELOPE><HEADER><VERSION>1</VERSION><STATUS>0</STATUS></HEADER><BODY><DATA><LINEERROR>Could not find Company 'ZZ TEST'</LINEERROR></DATA></BODY></ENVELOPE>`));
  ok("M3 an error RESPONSE throws", throws("<RESPONSE>Unknown Request, cannot be processed</RESPONSE>"));
  ok("M3 STATUS 0 throws", throws("<ENVELOPE><HEADER><STATUS>0</STATUS></HEADER><BODY><DATA><COLLECTION></COLLECTION></DATA></BODY></ENVELOPE>"));
  ok("M3 text with no collection envelope throws", throws("<ENVELOPE><BODY></BODY></ENVELOPE>") && throws("") && throws(undefined));
  ok("M3 an empty but valid reply is an empty list", !throws(valid("")) && !throws(valid(" ")));
  const post = (res: unknown) => async () => res;
  const nums = await takenNumbersOrThrow("x", "ZZ TEST", "Contra", post(valid("")));
  ok("M3 takenNumbersOrThrow: an empty valid reply gives []", Array.isArray(nums) && nums.length === 0);
  let threw = false;
  try { await takenNumbersOrThrow("x", "ZZ TEST", "Contra", post("<ENVELOPE><BODY><DATA><LINEERROR>bad</LINEERROR></DATA></BODY></ENVELOPE>")); } catch { threw = true; }
  ok("M3 takenNumbersOrThrow: an error reply throws, never []", threw);
  threw = false;
  try { await takenVouchersOrThrow("x", "ZZ TEST", "Purchase", post("<RESPONSE>Unknown Request</RESPONSE>")); } catch { threw = true; }
  ok("M3 takenVouchersOrThrow: an error reply throws", threw);
  const rows = parseTakenVouchers(valid(`<VOUCHER REMOTEID="x" VCHTYPE="Purchase"><DATE TYPE="Date">20261001</DATE><VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME><VOUCHERNUMBER>INV-77</VOUCHERNUMBER><PARTYLEDGERNAME TYPE="String">ZZ TEST SUPPLIER A</PARTYLEDGERNAME></VOUCHER>`));
  ok("H1 a Purchase read gives number, party and date", rows.length === 1 && rows[0].number === "INV-77" && rows[0].party === "ZZ TEST SUPPLIER A" && rows[0].date === "2026-10-01", JSON.stringify(rows));
}

void m3().then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});
