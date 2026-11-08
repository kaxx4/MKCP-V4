/**
 * JOB: the two safety rules of the bank-mail rig (`rigs/bank-mail-dummy.ts`), pure so an offline test can assert
 * them (`scripts/test-bank-mail-rig.ts`). No Tally, no database, no I/O.
 *
 *  - `sweepDeleteRefusal` (M2): may the sweep delete this voucher by this REMOTEID?
 *  - `partyUseRefusal` (M1): may the test party ledger be removed, or does something still use it?
 */
import { financialYearOf } from "../../../src/services/remoteId.js";
import { sameVoucherType, voucherLedgerNames } from "../../../src/services/safePush.js";
import { isSweepVoucher, BANK_MAIL_TEST_NUMBER } from "../../lib/testVoucherMatch.js";

/** The REMOTEID the server writes for a test bank-mail voucher (migration 0175): MKCP|<type>|<number>|<financial year>. */
export const bankMailRemoteId = (voucherType: string, voucherNumber: string, isoDate: string): string =>
  `MKCP|${voucherType}|${voucherNumber}|${financialYearOf(isoDate)}`;

/**
 * Why the sweep must NOT delete (null means it may). Before any delete:
 *  - the job's number is exactly ZZTESTBM plus 8 upper-case hex characters;
 *  - the job's REMOTEID is exactly the form the server writes for this voucher: no guesses, no other spelling;
 *  - what Tally holds under that number is one voucher, with exactly that number and type, passing the shared
 *    sweep guard and carrying ZZTEST in its narration.
 * Nothing found is allowed (there is nothing to delete); the caller then deletes nothing.
 */
export function sweepDeleteRefusal(
  job: { voucherType: string; voucherNumber?: string; date: string; remoteId?: string },
  found: { number: string; type: string; narration: string }[],
): string | null {
  const number = job.voucherNumber ?? "";
  if (!BANK_MAIL_TEST_NUMBER.test(number)) return `the job's number "${number}" is not ZZTESTBM plus exactly 8 upper-case hex characters`;
  const want = bankMailRemoteId(job.voucherType, number, job.date);
  if (job.remoteId !== want) return `the job's REMOTEID is not the form the server writes for this voucher (${want})`;
  if (found.length > 1) return `${found.length} vouchers are in Tally under that number; a person must look`;
  const v = found[0];
  if (!v) return null;
  if (v.number !== number) return `Tally returned a voucher numbered "${v.number}", not the job's number`;
  if (!sameVoucherType(v.type, job.voucherType)) return `the voucher in Tally is a ${v.type}, not a ${job.voucherType}`;
  if (!isSweepVoucher({ number: v.number, narration: v.narration }, "ZZTEST")) return "the voucher does not pass the shared sweep guard";
  if (!v.narration.includes("ZZTEST")) return "the voucher's narration does not carry ZZTEST";
  return null;
}

/**
 * Why the test party ledger must NOT be removed (null means nothing uses it that this rule can see).
 *  - any ZZTESTBM voucher still in the books (the only vouchers this rig books that name the party);
 *  - any voucher read for a checked day that names the party on a LEDGER LINE, read with the production reader
 *    (`voucherLedgerNames`), because Tally overwrites the header party on Receipt and Payment;
 *  - any voucher whose header names it (from the census read).
 */
export function partyUseRefusal(party: string, o: { voucherXmls: string[]; bankMailNumbers: string[]; headerCount: number }): string | null {
  if (o.bankMailNumbers.length) return `${o.bankMailNumbers.length} ZZTESTBM voucher(s) are still in the books (${o.bankMailNumbers.slice(0, 3).join(", ")})`;
  const onLine = o.voucherXmls.filter((v) => voucherLedgerNames(v).includes(party)).length;
  if (onLine) return `${onLine} voucher(s) name it on a ledger line`;
  if (o.headerCount) return `${o.headerCount} voucher(s) name it as the header party`;
  return null;
}

/**
 * The plain days (YYYY-MM-DD) to read for the party check: the day of every voucher in the census plus the extra days,
 * each once, sorted. A census key is `YYYYMMDD|type|number`; one that is not a date is skipped, never read.
 */
export function daysToRead(censusKeys: string[], extraIso: string[]): string[] {
  const days = new Set<string>(extraIso.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)));
  for (const k of censusKeys) {
    const m = /^(\d{4})(\d{2})(\d{2})\|/.exec(k);
    if (m) days.add(`${m[1]}-${m[2]}-${m[3]}`);
  }
  return [...days].sort();
}
