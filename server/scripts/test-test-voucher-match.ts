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
import { isDrainTestNumber } from "./lib/testVoucherMatch.js";

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
// Real supplier bills that must NOT count as test
expect("MKCP-05 (PARTY 154 ENTERPRISE bill) is NOT a test voucher", isDrainTestNumber("MKCP-05"), false);
expect("MKCP-01 (PARTY 154 ENTERPRISE bill) is NOT a test voucher", isDrainTestNumber("MKCP-01"), false);
expect("MKCP-TEST-123 is NOT a test voucher (bare MKCP- series)", isDrainTestNumber("MKCP-TEST-123"), false);
expect("26-27/0679 (company series) is NOT a test voucher", isDrainTestNumber("26-27/0679"), false);
expect("empty number is NOT a test voucher", isDrainTestNumber(""), false);
expect("undefined number is NOT a test voucher", isDrainTestNumber(undefined as unknown as string), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
