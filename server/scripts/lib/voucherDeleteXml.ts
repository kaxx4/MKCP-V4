/**
 * JOB: the ONE delete message for a harness (ZZ TEST) voucher, and the rule for which vouchers a sweep may send it for (D-M.266).
 *
 * Used by both `sweep-test-vouchers.ts` and `rigs/p1-cleanup.ts`; neither carries its own copy of the XML. Pure: builds text and answers yes or no,
 * sends nothing. Whoever sends it does so through `tallyPost()` (which runs the company and practice-GUID checks) from a script that has called
 * `guardScriptWrites()`.
 *
 * Why this exists next to safePush: pushGuard checks a voucher someone is CREATING and refuses one with no ledger entries, which is right for a
 * voucher and wrong for a delete by REMOTEID. A stranded voucher's entries are unknown, and a delete needs only its handle.
 */

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The Delete import for one voucher. `day` is YYYYMMDD. `number` may be empty (a Journal carries none): the element is then left out.
 * For a non-empty number with no quote in it the text is byte for byte what `sweep-test-vouchers.ts` sent before this builder existed
 * (`scripts/test-voucher-delete-xml.ts` holds that old text and compares).
 */
export function voucherDeleteXml(o: { company: string; remoteId: string; type: string; day: string; number: string }): string {
  if (!o.remoteId.trim()) throw new Error("a delete needs the voucher's REMOTEID; none was given");
  if (!/^\d{8}$/.test(o.day)) throw new Error(`a delete needs the day as YYYYMMDD (got "${o.day}")`);
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Import</TALLYREQUEST><TYPE>Data</TYPE><ID>Vouchers</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${esc(o.company)}</SVCURRENTCOMPANY></STATICVARIABLES></DESC>
<DATA><TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER REMOTEID="${esc(o.remoteId)}" VCHTYPE="${esc(o.type)}" ACTION="Delete"><DATE>${o.day}</DATE><VOUCHERTYPENAME>${esc(o.type)}</VOUCHERTYPENAME>${o.number ? `<VOUCHERNUMBER>${esc(o.number)}</VOUCHERNUMBER>` : ""}</VOUCHER></TALLYMESSAGE></DATA></BODY></ENVELOPE>`;
}

const unesc = (s: string): string => s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** The REMOTEID Tally itself holds for a voucher, from the opening tag of a voucher block it returned; "" when the block does not carry one. */
export function reportedRemoteId(block: string): string {
  const m = /<VOUCHER\b[^>]*\bREMOTEID="([^"]*)"/.exec(block);
  return m ? unesc(m[1]) : "";
}

/** A harness voucher: number ZZTEST<digits>/..., or no number at all (a Journal has none) and a narration that starts "ZZTEST ". Nothing looser. */
export function isHarnessVoucher(v: { number: string; narration?: string }): boolean {
  return /^ZZTEST\d*\//.test(v.number) || (v.number.trim() === "" && /^ZZTEST /.test((v.narration ?? "").trim()));
}

/**
 * The eight stranded vouchers of 17 and 18 September 2026 that an older harness left on a real party's ledger. Pinned by day, type and number (or
 * narration for a Journal, which has no number). Only these may be deleted although their party is not a ZZ TEST ledger (D-M.266).
 */
export const LISTED_STRANDED: ReadonlySet<string> = new Set([
  "2026-09-17|Payment|ZZTEST/N04673", "2026-09-17|Payment|ZZTEST/X69943", "2026-09-17|Payment|ZZTEST/X69944",
  "2026-09-18|Payment|ZZTEST/X83360", "2026-09-18|Payment|ZZTEST/X83361",
  "2026-09-18|Journal|ZZTEST JRNL 25255", "2026-09-18|Journal|ZZTEST JRNL 61885", "2026-09-18|Journal|ZZTEST JRNL 53691",
]);

/**
 * Why this voucher must NOT be deleted, or null when it may. It must be a harness voucher AND either sit on a party the dummy runs themselves made
 * (a "ZZ TEST ..." ledger, or no party at all) or be one of the eight listed above (by day, type and number or narration).
 */
export function deleteRefusal(v: { iso: string; type: string; number: string; narration: string; party: string }): string | null {
  if (!isHarnessVoucher(v)) return "its number is not ZZTEST<digits>/... and it is not a numberless Journal whose narration starts \"ZZTEST \"";
  const key = `${v.iso}|${v.type}|${v.number || v.narration}`;
  if (LISTED_STRANDED.has(key)) return null;
  const party = v.party.trim();
  if (party === "" || /^ZZ TEST/i.test(party)) return null;
  return `its party "${party}" is not a ZZ TEST ledger and it is not one of the listed stranded vouchers`;
}
