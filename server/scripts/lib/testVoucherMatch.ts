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
const DRAIN_TEST_PREFIXES = ["ZZTEST", "CLAUDE-TEST", "RPLY-", "VERIFY-", "SMOKE-", "DEMO-"];

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

/** What a harness sent, as far as finding its stored copy goes. */
export interface SentVoucher { voucherType: string; voucherNumber?: string; narration?: string }
/** One voucher as a day's read-back lists it. */
export interface StoredVoucher { number: string; narration: string; type: string }

/**
 * The stored copy of a voucher the harness sent, or undefined.
 * By number first. When Tally stored no number (this company's Journal type
 * numbers "None", so a sent number is dropped), by narration, and only when
 * exactly one voucher of that type carries it: narrations repeat, and a
 * guess would point at another voucher.
 */
export function storedCopyOf(sent: SentVoucher, day: readonly StoredVoucher[]): StoredVoucher | undefined {
  const num = (sent.voucherNumber ?? "").trim();
  if (num) {
    const byNumber = day.filter((v) => v.number === num && v.type.toLowerCase() === sent.voucherType.toLowerCase());
    if (byNumber.length === 1) return byNumber[0];
  }
  const narr = (sent.narration ?? "").trim();
  if (!narr) return undefined;
  const byNarration = day.filter((v) => !v.number && v.narration === narr && v.type.toLowerCase() === sent.voucherType.toLowerCase());
  return byNarration.length === 1 ? byNarration[0] : undefined;
}

/**
 * True when the harness must remove this voucher itself, by the REMOTEID it
 * created it with, because the normal sweep (isSweepVoucher) cannot see it:
 * an empty narration, or a number Tally did not keep. Only for a voucher the
 * harness sent under its own mark, so a real voucher is never chosen.
 */
export function harnessMustRemove(sent: SentVoucher, stored: StoredVoucher | undefined, prefix: string): boolean {
  if (!stored || !sweepPrefixAllowed(prefix)) return false;
  if (!new RegExp(`^${prefix}\\d*[/-]`).test((sent.voucherNumber ?? "").trim())) return false;
  return !isSweepVoucher(stored, prefix);
}
