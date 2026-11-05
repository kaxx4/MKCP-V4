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
import { formatSeriesNumber, seriesCounter, indiaDateOf, isErpSeriesNumber, seriesDefaultFor } from "../src/services/voucherSeries.js";
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
const web = join(here, "..", "..", "..", "lane-plumbing-web", "web-dashboard", "contracts", "voucher-series.json");
if (existsSync(web)) ok("the contract here is byte-identical to the web repo's", readFileSync(web, "utf8").replace(/\r\n/g, "\n") === readFileSync(mine, "utf8").replace(/\r\n/g, "\n"));
else console.log("  (web repo not beside this one: byte check skipped)");

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
