/**
 * Pure matchers for harness test vouchers. No Tally, no Supabase, no I/O.
 *
 * `MKCP-` is NOT a test prefix. It is a real supplier bill series in these
 * books (`MKCP-01` ... `MKCP-09`, PARTY 154 ENTERPRISE purchases). Matching it
 * would make a drain or sweep treat a year of real purchases as disposable.
 *
 * The harness marker is `ZZTEST`, the value exported as MARK by
 * `push-fidelity.ts`; `fidelity/*` stamps it on voucher numbers (`ZZTEST/...`)
 * and narrations (`ZZTEST ...`). `GSTV` is the marker of the six-voucher GST
 * harness (`verify-six-vouchers.ts`, narration `GSTV<digits> ...`).
 */

/** Prefixes the push-agent drain may treat as test numbers. */
const DRAIN_TEST_PREFIXES = ["ZZTEST", "RPLY-", "VERIFY-", "SMOKE-", "DEMO-"];

/**
 * True when a pending queue row's voucher number is a harness test number.
 * Case-sensitive: harness numbers are written in capitals.
 */
export function isDrainTestNumber(number: string): boolean {
  if (typeof number !== "string" || number.length === 0) return false;
  return DRAIN_TEST_PREFIXES.some((p) => number.startsWith(p));
}
