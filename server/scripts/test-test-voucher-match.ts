/**
 * Which vouchers count as harness test vouchers, asserted in BOTH directions.
 *
 * Pure: no Tally, no Supabase. A real supplier bill series shares a prefix with
 * the harness (`MKCP-01` ... `MKCP-09` are PARTY 154 ENTERPRISE purchases), so a
 * test that only asserts "test voucher matches" would pass for a matcher that
 * also deletes real purchases. Every rule is therefore checked with a real
 * voucher that must NOT match as well as a harness voucher that must.
 *
 *   npx tsx server/scripts/test-test-voucher-match.ts
 */
import { isDrainTestNumber, isSweepVoucher, sweepPrefixAllowed, storedCopyOf, harnessMustRemove } from "./lib/testVoucherMatch.js";

let pass = 0, fail = 0;

function expect(what: string, got: boolean, want: boolean): void {
  if (got === want) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${what}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${what} — expected ${want}, got ${got}`); }
}

console.log("\nwatch-agent-drain: which pending numbers count as test");
// Harness numbers that must count as test
expect("ZZTEST/CN12345 is a harness test voucher", isDrainTestNumber("ZZTEST/CN12345"), true);
expect("ZZTEST-7 is a harness test voucher", isDrainTestNumber("ZZTEST-7"), true);
expect("RPLY-3 is a harness test voucher", isDrainTestNumber("RPLY-3"), true);
expect("VERIFY-01 is a harness test voucher", isDrainTestNumber("VERIFY-01"), true);
expect("CLAUDE-TEST-1 is a harness test voucher", isDrainTestNumber("CLAUDE-TEST-1"), true);
// Real supplier bills that must NOT count as test
expect("MKCP-05 (PARTY 154 ENTERPRISE bill) is NOT a test voucher", isDrainTestNumber("MKCP-05"), false);
expect("MKCP-01 (PARTY 154 ENTERPRISE bill) is NOT a test voucher", isDrainTestNumber("MKCP-01"), false);
expect("MKCP-TEST-123 is NOT a test voucher (bare MKCP- series)", isDrainTestNumber("MKCP-TEST-123"), false);
expect("26-27/0679 (company series) is NOT a test voucher", isDrainTestNumber("26-27/0679"), false);
expect("empty number is NOT a test voucher", isDrainTestNumber(""), false);
expect("undefined number is NOT a test voucher", isDrainTestNumber(undefined as unknown as string), false);

console.log("\nsweep-test-vouchers: which prefixes may be swept");
expect("ZZTEST is an allowed sweep prefix", sweepPrefixAllowed("ZZTEST"), true);
expect("GSTV is an allowed sweep prefix", sweepPrefixAllowed("GSTV"), true);
expect("bare MKCP is refused as a sweep prefix", sweepPrefixAllowed("MKCP"), false);
expect("MKCP- is refused as a sweep prefix", sweepPrefixAllowed("MKCP-"), false);
expect("empty prefix is refused", sweepPrefixAllowed(""), false);
expect("lower-case zztest is refused (exact match only)", sweepPrefixAllowed("zztest"), false);
expect("ZZTEST/ (with slash) is refused, the bare mark is the prefix", sweepPrefixAllowed("ZZTEST/"), false);

const harness = { number: "ZZTEST/CN12345", narration: "ZZTEST cancel action 12345" };
expect("ZZTEST number with ZZTEST narration is swept", isSweepVoucher(harness, "ZZTEST"), true);
expect("ZZTEST number with no marker in narration is NOT swept",
  isSweepVoucher({ number: "ZZTEST/CN1", narration: "real invoice" }, "ZZTEST"), false);
expect("ZZTEST marker in narration but a real company number is NOT swept",
  isSweepVoucher({ number: "26-27/0679", narration: "ZZTEST leftover" }, "ZZTEST"), false);
expect("real MKCP-05 with a ZZTEST narration is NOT swept under ZZTEST",
  isSweepVoucher({ number: "MKCP-05", narration: "ZZTEST" }, "ZZTEST"), false);
expect("real MKCP-05 is NOT swept even when the prefix is MKCP",
  isSweepVoucher({ number: "MKCP-05", narration: "MKCP-05 PARTY 154 ENTERPRISE" }, "MKCP"), false);
expect("GSTV harness voucher with GSTV narration is swept",
  isSweepVoucher({ number: "GSTV12/1", narration: "GSTV12345 six-voucher GST audit" }, "GSTV"), true);
expect("ZZTEST number is NOT swept under the GSTV prefix",
  isSweepVoucher({ number: "ZZTEST/CN1", narration: "ZZTEST x" }, "GSTV"), false);
expect("number matching but narration empty is NOT swept",
  isSweepVoucher({ number: "ZZTEST/CN1", narration: "" }, "ZZTEST"), false);

console.log("\ntest-edge-cases --push: which of its own vouchers the sweep cannot see");
// Third review, 5-Nov-2026: the empty-narration purchase and the Journals (stored
// with no number) were left behind by the sweep and needed a one-off delete.
const day = [
  { number: "ZZTEST0080504/17", narration: "", type: "Purchase" },
  { number: "", narration: "ZZTEST0080504 Journal 38", type: "Journal" },
  { number: "ZZTEST0080504/5", narration: "ZZTEST0080504 edge case", type: "Purchase" },
  { number: "ZZTEST0080504/6", narration: "ZZTEST0080504 edge case", type: "Purchase" },
  { number: "26-27/0679", narration: "AS PER BILL", type: "Sales" },
];
const sentEmpty = { voucherType: "Purchase", voucherNumber: "ZZTEST0080504/17", narration: "" };
const sentJournal = { voucherType: "Journal", voucherNumber: "ZZTEST0080504/T38", narration: "ZZTEST0080504 Journal 38" };
const sentPlain = { voucherType: "Purchase", voucherNumber: "ZZTEST0080504/5", narration: "ZZTEST0080504 edge case" };
const sentGone = { voucherType: "Purchase", voucherNumber: "ZZTEST0080504/99", narration: "ZZTEST0080504 edge case" };
expect("the stored copy is found by its number", storedCopyOf(sentEmpty, day)?.number === "ZZTEST0080504/17", true);
expect("a voucher stored with no number is found by a narration only it carries", storedCopyOf(sentJournal, day)?.type === "Journal", true);
expect("a shared narration never stands in for a missing number", storedCopyOf(sentGone, day) === undefined, true);
expect("an empty-narration purchase must be removed by the harness itself", harnessMustRemove(sentEmpty, storedCopyOf(sentEmpty, day), "ZZTEST"), true);
expect("a Journal stored with no number must be removed by the harness itself", harnessMustRemove(sentJournal, storedCopyOf(sentJournal, day), "ZZTEST"), true);
expect("a voucher the sweep can see is left to the sweep", harnessMustRemove(sentPlain, storedCopyOf(sentPlain, day), "ZZTEST"), false);
expect("nothing stored, nothing to remove", harnessMustRemove(sentGone, undefined, "ZZTEST"), false);
expect("a sent voucher without the harness mark in its number is never removed",
  harnessMustRemove({ voucherType: "Sales", voucherNumber: "26-27/0679", narration: "" }, day[4], "ZZTEST"), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
