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

/**
 * Harness marks the sweep may delete by. Exact strings, nothing else: a sweep
 * prefix that is not one of these is refused, which is what keeps a bare
 * `MKCP` or `MKCP-` from ever reaching the delete loop.
 */
const SWEEP_MARKS = ["ZZTEST", "GSTV"];

export function sweepPrefixAllowed(prefix: string): boolean {
  return typeof prefix === "string" && SWEEP_MARKS.includes(prefix);
}

/**
 * True when a voucher is a harness voucher the sweep may delete. Both must hold:
 *  - the number is the mark followed by digits and a separator (`ZZTEST/CN1`,
 *    `GSTV12/1`), so a real `MKCP-05` never matches;
 *  - the narration carries the same mark, so a voucher that merely shares the
 *    number shape but was not written by a harness is left alone.
 * An unlisted prefix returns false regardless of the voucher.
 */
export function isSweepVoucher(v: { number: string; narration: string }, prefix: string): boolean {
  if (!sweepPrefixAllowed(prefix)) return false;
  const number = typeof v.number === "string" ? v.number : "";
  const narration = typeof v.narration === "string" ? v.narration : "";
  const numberShape = new RegExp(`^${prefix}\\d*[/-]`);
  return numberShape.test(number) && narration.includes(prefix);
}
