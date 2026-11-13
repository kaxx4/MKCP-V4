/**
 * D-M.266, offline: the one delete message for a harness voucher (scripts/lib/voucherDeleteXml.ts).
 *   - it matches, byte for byte, the message sweep-test-vouchers.ts built inline before the builder existed (the old text is frozen below);
 *   - neither the sweep nor rigs/p1-cleanup.ts carries delete XML of its own any more;
 *   - Tally's own REMOTEID is read from a voucher block;
 *   - what a sweep may delete: a harness voucher on a ZZ TEST party, or one of the eight listed stranded vouchers, nothing else.
 * No Tally, no database.
 *
 *   npx tsx scripts/test-voucher-delete-xml.ts
 */
import { readFileSync } from "node:fs";
import { voucherDeleteXml, reportedRemoteId, isHarnessVoucher, deleteRefusal, LISTED_STRANDED } from "./lib/voucherDeleteXml.js";

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? `: ${detail}` : ""}`); }
};

/** FROZEN: the delete message exactly as sweep-test-vouchers.ts built it before D-M.266 (its own esc: & < > only). */
const oldEsc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const oldSweepXml = (company: string, remoteId: string, type: string, DAY: string, number: string) => `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Import</TALLYREQUEST><TYPE>Data</TYPE><ID>Vouchers</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${oldEsc(company)}</SVCURRENTCOMPANY></STATICVARIABLES></DESC>
<DATA><TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER REMOTEID="${oldEsc(remoteId)}" VCHTYPE="${oldEsc(type)}" ACTION="Delete"><DATE>${DAY}</DATE><VOUCHERTYPENAME>${oldEsc(type)}</VOUCHERTYPENAME><VOUCHERNUMBER>${oldEsc(number)}</VOUCHERNUMBER></VOUCHER></TALLYMESSAGE></DATA></BODY></ENVELOPE>`;

console.log("\n  the envelope");
{
  const cases: Array<[string, string, string, string, string]> = [
    ["ZZ CO - (from 1-Apr-26)", "MKCP|Payment|ZZTEST/N1|2026-27", "Payment", "20260917", "ZZTEST/N1"],
    ["ZZ CO", "MKCP-PAYMENT-ZZTEST-first-269968", "Payment", "20260918", "ZZTEST/X69943"],
    ["A & B <CO>", "MKCP|Sales|ZZTEST/S&1|2026-27", "Sales", "20260101", "ZZTEST/S>1"],
    ["ZZ CO", "MKCP|Delivery Note|ZZTEST/D1|2026-27", "Delivery Note", "20260918", "ZZTEST/DNOTE1"],
  ];
  ok("it equals the old sweep's message byte for byte, for every case without a quote", cases.every(([c, r, t, d, n]) => voucherDeleteXml({ company: c, remoteId: r, type: t, day: d, number: n }) === oldSweepXml(c, r, t, d, n)));
  const q = voucherDeleteXml({ company: "ZZ CO", remoteId: 'ID"with"quotes', type: "Payment", day: "20260917", number: "ZZTEST/N1" });
  ok("a quote in the REMOTEID is escaped so it cannot end the attribute", q.includes('REMOTEID="ID&quot;with&quot;quotes"') && !q.includes('ID"with'));
  const j = voucherDeleteXml({ company: "ZZ CO", remoteId: "R1", type: "Journal", day: "20260918", number: "" });
  ok("a numberless voucher (a Journal) leaves the number element out", !/VOUCHERNUMBER/.test(j) && /VCHTYPE="Journal" ACTION="Delete"/.test(j));
  let e1 = "", e2 = "";
  try { voucherDeleteXml({ company: "ZZ CO", remoteId: "  ", type: "Payment", day: "20260917", number: "ZZTEST/N1" }); } catch (e) { e1 = (e as Error).message; }
  try { voucherDeleteXml({ company: "ZZ CO", remoteId: "R1", type: "Payment", day: "2026-09-17", number: "ZZTEST/N1" }); } catch (e) { e2 = (e as Error).message; }
  ok("no REMOTEID, or a day that is not YYYYMMDD, builds nothing", /REMOTEID/.test(e1) && /YYYYMMDD/.test(e2));
}

console.log("\n  Tally's own REMOTEID");
{
  ok("read from the opening tag of a voucher block", reportedRemoteId('<VOUCHER REMOTEID="MKCP-PAYMENT-ZZTEST-first-269968" VCHKEY="x" VCHTYPE="Payment"><DATE>20260917</DATE></VOUCHER>') === "MKCP-PAYMENT-ZZTEST-first-269968");
  ok("entities are decoded", reportedRemoteId('<VOUCHER REMOTEID="A&amp;B&quot;C" VCHTYPE="Payment">') === 'A&B"C');
  ok("a block with no REMOTEID gives an empty answer (never a guess)", reportedRemoteId('<VOUCHER VCHTYPE="Payment"><VOUCHERNUMBER>1</VOUCHERNUMBER></VOUCHER>') === "");
  ok("a REMOTEID further down the block is not taken for the voucher's own", reportedRemoteId('<VOUCHER VCHTYPE="Payment"><X REMOTEID="inner"/></VOUCHER>') === "");
}

console.log("\n  what a sweep may delete");
{
  const base = { iso: "2026-09-17", type: "Payment", number: "ZZTEST/N04673", narration: "ZZTEST numbering probe", party: "A REAL PARTY LTD" };
  ok("eight vouchers are listed", LISTED_STRANDED.size === 8);
  ok("a listed stranded voucher may go although its party is a real ledger", deleteRefusal(base) === null);
  ok("the same number on another day is not the listed one: refused (real party)", /not a ZZ TEST ledger/.test(deleteRefusal({ ...base, iso: "2026-09-19" }) ?? ""));
  ok("an unlisted ZZTEST voucher on a real party is refused", /not a ZZ TEST ledger/.test(deleteRefusal({ ...base, number: "ZZTEST/X1" }) ?? ""));
  ok("an unlisted ZZTEST voucher on a ZZ TEST party may go", deleteRefusal({ ...base, number: "ZZTEST/X1", party: "ZZ TEST DEBTOR 123456" }) === null);
  ok("a ZZTEST voucher with no party at all may go (a Journal, a Contra)", deleteRefusal({ ...base, number: "ZZTEST/K1", party: "" }) === null);
  ok("a real voucher number is refused outright, whatever its party", /not ZZTEST/.test(deleteRefusal({ ...base, number: "26-27/0662", party: "ZZ TEST DEBTOR 1" }) ?? ""));
  ok("a voucher number that only CONTAINS ZZTEST is refused", deleteRefusal({ ...base, number: "A-ZZTEST/1", party: "ZZ TEST DEBTOR 1" }) !== null);
  const jr = { iso: "2026-09-18", type: "Journal", number: "", narration: "ZZTEST JRNL 25255", party: "" };
  ok("a numberless Journal whose narration starts ZZTEST is a harness voucher and, listed, may go", isHarnessVoucher(jr) && deleteRefusal(jr) === null);
  ok("a numberless Journal with another narration is refused", deleteRefusal({ ...jr, narration: "SALARY NOVEMBER" }) !== null && !isHarnessVoucher({ number: "", narration: "SALARY NOVEMBER" }));
  ok("a narration that only contains ZZTEST later is not enough", !isHarnessVoucher({ number: "", narration: "paid ZZTEST later" }));
  ok("a numbered voucher is never a harness voucher by its narration", !isHarnessVoucher({ number: "26-27/1", narration: "ZZTEST something" }));
}

console.log("\n  one builder, no copies");
{
  const sweep = readFileSync(new URL("./sweep-test-vouchers.ts", import.meta.url), "utf8");
  const rig = readFileSync(new URL("./rigs/p1-cleanup.ts", import.meta.url), "utf8");
  ok("the sweep builds its delete through the shared builder and has no delete XML of its own", /voucherDeleteXml\(/.test(sweep) && !/ACTION="Delete"/.test(sweep));
  ok("the cleanup rig does too", /voucherDeleteXml\(/.test(rig) && !/ACTION="Delete"/.test(rig) && !/<ENVELOPE/.test(rig));
  ok("the rig sends through tallyPost, from a file behind guardScriptWrites, after the practice preflight, and not through push()", /tallyPost\(l\.url, xml/.test(rig) && /guardScriptWrites\("rigs\/p1-cleanup"\)/.test(rig) && /await preflight\(\)/.test(rig) && !/\bpush\(/.test(rig));
  ok("the rig refuses by deleteRefusal before it sends and takes the REMOTEID from Tally's own read", /deleteRefusal\(/.test(rig) && /reportedRemoteId\(/.test(rig));
  ok("the sweep prefers the REMOTEID Tally reports, then the harness spellings", /reportedRemoteId\(v\)/.test(sweep) && /remoteIdGuesses\(type, number\)/.test(sweep));
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
