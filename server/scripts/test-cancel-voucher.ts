/**
 * Can a voucher be CANCELLED over XML, rather than deleted?
 *
 * The distinction matters to the operator, not to the machine. A deleted
 * voucher leaves a hole in the number sequence; a cancelled one keeps its
 * number and its place, which is what you want for anything a customer has
 * already seen — they have the invoice number, and it has to still mean
 * something when they ring up about it.
 *
 * ── Why this is being tested rather than assumed ──────────────────────────
 *
 * The rebuild plan's summary says vouchers "create/alter/cancel/delete". Create,
 * Alter and Delete are all implemented and proved. CANCEL IS NOWHERE — not in
 * voucherPusher, not in the payload contract, not in any harness. The claim
 * appears to have been carried forward from an assumption.
 *
 * This codebase has produced seven features that typechecked, looked right and
 * did nothing, so a capability nobody has exercised is a claim, not a fact.
 * Building a "Cancel" button on top of one would be the eighth.
 *
 * ── What is probed ────────────────────────────────────────────────────────
 *
 * Two candidate shapes, each on its own subject voucher:
 *
 *   A. ACTION="Alter" carrying <ISCANCELLED>Yes</ISCANCELLED>
 *   B. ACTION="Cancel" as the action itself
 *
 * For each: does Tally accept it, does the voucher survive, does it come back
 * marked cancelled, and does it KEEP its number? A "cancel" that deletes the
 * voucher, or that silently does nothing while reporting success, is worse than
 * no cancel at all.
 *
 * ── RESULT (2026-09-12) ───────────────────────────────────────────────────
 *
 *   A. ISCANCELLED flag  altered=1, and the voucher comes back ISCANCELLED=No.
 *                        ACCEPTED AND DISCARDED. Every signal a caller can see
 *                        says success; the invoice is still live and still in
 *                        GSTR-1. This is the trap.
 *   B. ACTION="Cancel"   WORKS. Same MASTERID, same number, ISCANCELLED=Yes,
 *                        no duplicate.
 *
 * So Cancel is real, and only one of the two obvious ways to ask for it does
 * anything. Shape A is asserted below as a known refusal rather than deleted,
 * so it stays visible.
 *
 * Every subject carries a REMOTEID, so everything here can be cleaned up
 * afterwards — unlike the adoption probe, which had to leave a voucher behind.
 *
 *   npx tsx scripts/test-cancel-voucher.ts [--keep]
 */
import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { convertCompanies } from "../src/converters/convert.js";
import { safePush } from "../src/services/safePush.js";

const U = process.env.TALLY_URL || "http://localhost:9000";
const KEEP = process.argv.includes("--keep");
const DATE = new Date().toISOString().slice(0, 10);
const STAMP = DATE.replace(/-/g, "");
const TAG = `CANC${Date.now().toString().slice(-5)}`;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fld = (v: string, t: string) => {
  const m = new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, "i").exec(v);
  return m ? m[1].trim() : "";
};

let passed = 0, failed = 0;
const failures: string[] = [];
const ok = (label: string, cond: boolean, detail = "") => {
  if (cond) { passed++; console.log(`    \x1b[32m✓\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`); }
  else { failed++; failures.push(label); console.log(`    \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`); }
};
const H = (s: string) => console.log(`\n\x1b[1m── ${s} ${"─".repeat(Math.max(0, 56 - s.length))}\x1b[0m`);
const post = (xml: string) => tallyPost(U, xml, 60_000, true) as Promise<string>;

/** Scoped to ONE day — entry blocks over a wider range wedge Tally's port. */
async function vouchersToday(company: string): Promise<string[]> {
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>MkCanc</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="MkCanc" ISMODIFY="No"><TYPE>Voucher</TYPE>
<NATIVEMETHOD>Date</NATIVEMETHOD><NATIVEMETHOD>VoucherNumber</NATIVEMETHOD>
<NATIVEMETHOD>VoucherTypeName</NATIVEMETHOD><NATIVEMETHOD>MasterId</NATIVEMETHOD>
<NATIVEMETHOD>IsCancelled</NATIVEMETHOD><NATIVEMETHOD>IsOptional</NATIVEMETHOD>
<FILTER>MkCancF</FILTER></COLLECTION>
<SYSTEM TYPE="Formulae" NAME="MkCancF">($$YearOfDate:$Date * 10000 + $$MonthOfDate:$Date * 100 + $$DayOfDate:$Date) = ${STAMP}</SYSTEM>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
  const raw: string = await tallyPost(U, xml, 180_000, true);
  return [...raw.matchAll(/<VOUCHER\b[^>]*>[\s\S]*?<\/VOUCHER>/g)].map((m) => m[0]);
}

const mine = (day: string[], number: string) =>
  day.filter((v) => fld(v, "VOUCHERNUMBER") === number);

/** A minimal two-line Payment — no stock, no GST, nothing to get wrong. */
function subjectXml(company: string, number: string, remoteId: string, bank: string, party: string): string {
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Import</TALLYREQUEST><TYPE>Data</TYPE><ID>Vouchers</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES></DESC>
<DATA><TALLYMESSAGE xmlns:UDF="TallyUDF">
<VOUCHER REMOTEID="${esc(remoteId)}" VCHTYPE="Payment" ACTION="Create">
<DATE>${STAMP}</DATE><EFFECTIVEDATE>${STAMP}</EFFECTIVEDATE>
<VOUCHERTYPENAME>Payment</VOUCHERTYPENAME><VOUCHERNUMBER>${esc(number)}</VOUCHERNUMBER>
<PARTYLEDGERNAME>${esc(party)}</PARTYLEDGERNAME>
<NARRATION>cancel probe — safe to remove</NARRATION>
<ALLLEDGERENTRIES.LIST><LEDGERNAME>${esc(party)}</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-100.00</AMOUNT></ALLLEDGERENTRIES.LIST>
<ALLLEDGERENTRIES.LIST><LEDGERNAME>${esc(bank)}</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>100.00</AMOUNT></ALLLEDGERENTRIES.LIST>
</VOUCHER></TALLYMESSAGE></DATA></BODY></ENVELOPE>`;
}

function cancelXml(company: string, remoteId: string, number: string, style: "flag" | "action"): string {
  const action = style === "action" ? "Cancel" : "Alter";
  const flag = style === "flag" ? `<ISCANCELLED>Yes</ISCANCELLED>` : "";
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Import</TALLYREQUEST><TYPE>Data</TYPE><ID>Vouchers</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES></DESC>
<DATA><TALLYMESSAGE xmlns:UDF="TallyUDF">
<VOUCHER REMOTEID="${esc(remoteId)}" VCHTYPE="Payment" ACTION="${action}">
<DATE>${STAMP}</DATE><VOUCHERTYPENAME>Payment</VOUCHERTYPENAME>
<VOUCHERNUMBER>${esc(number)}</VOUCHERNUMBER>${flag}
</VOUCHER></TALLYMESSAGE></DATA></BODY></ENVELOPE>`;
}

async function remove(company: string, remoteId: string): Promise<void> {
  await post(`<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Import</TALLYREQUEST><TYPE>Data</TYPE><ID>Vouchers</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES></DESC>
<DATA><TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER REMOTEID="${esc(remoteId)}" VCHTYPE="Payment" ACTION="Delete"><DATE>${STAMP}</DATE><VOUCHERTYPENAME>Payment</VOUCHERTYPENAME></VOUCHER></TALLYMESSAGE></DATA></BODY></ENVELOPE>`);
}

(async () => {
  const company = convertCompanies(await tallyPost(U, HEALTH_XML, 10_000))[0]!.name;

  console.log(`\n\x1b[1mCan a voucher be cancelled, rather than deleted?\x1b[0m\n`);
  console.log(`company  "${company}"`);
  console.log(`subjects ${TAG}/A (ISCANCELLED flag) and ${TAG}/B (ACTION="Cancel")`);
  console.log(`\nBoth carry a REMOTEID, so both can be removed afterwards.\n`);

  // Real ledgers, so nothing is refused for an unrelated reason.
  const day0 = await vouchersToday(company);
  const bank = "HDFC BANK";
  const party = "Cash";

  const made: string[] = [];
  try {
    for (const style of ["flag", "action"] as const) {
      const number = `${TAG}/${style === "flag" ? "A" : "B"}`;
      const remoteId = `MKCP|Payment|${number}|2026-27`;
      H(style === "flag" ? `A. ACTION="Alter" + <ISCANCELLED>Yes</ISCANCELLED>` : `B. ACTION="Cancel"`);

      const created = await post(subjectXml(company, number, remoteId, bank, party));
      const madeOk = (parseInt(fld(created, "CREATED") || "0", 10) || 0) === 1;
      ok(`${number} created`, madeOk, fld(created, "LINEERROR") || "created=1");
      if (!madeOk) continue;
      made.push(remoteId);

      const before = mine(await vouchersToday(company), number);
      ok("it is in the books, uncancelled", before.length === 1 && /^no$/i.test(fld(before[0], "ISCANCELLED")),
        `${before.length} found, ISCANCELLED=${before[0] ? fld(before[0], "ISCANCELLED") : "?"}`);
      const masterId = before[0] ? fld(before[0], "MASTERID") : "";

      const resp = await post(cancelXml(company, remoteId, number, style));
      const altered = parseInt(fld(resp, "ALTERED") || "0", 10) || 0;
      const createdN = parseInt(fld(resp, "CREATED") || "0", 10) || 0;
      const deleted = parseInt(fld(resp, "DELETED") || "0", 10) || 0;
      const err = fld(resp, "LINEERROR");
      console.log(`    response: altered=${altered} created=${createdN} deleted=${deleted}${err ? ` LINEERROR="${err}"` : ""}`);

      /* Never judge by the response. A failed delete has been observed
         returning DELETED=1 alongside a LINEERROR, and an Alter against an
         unknown handle performs a silent CREATE. Read the books instead. */
      const after = mine(await vouchersToday(company), number);
      ok("no duplicate was created", after.length <= 1, `${after.length} voucher(s) with this number`);
      ok("the voucher still EXISTS — a cancel must not delete it", after.length === 1,
        after.length === 0 ? "it is gone" : `${after.length} found`);
      if (after.length !== 1) continue;

      ok("it kept its number, which is the whole point",
        fld(after[0], "VOUCHERNUMBER") === number, fld(after[0], "VOUCHERNUMBER"));
      ok("it kept its MASTERID", fld(after[0], "MASTERID") === masterId,
        `${masterId} → ${fld(after[0], "MASTERID")}`);
      const cancelled = /^yes$/i.test(fld(after[0], "ISCANCELLED"));
      if (style === "flag") {
        /* THE FINDING, and it is a trap rather than a gap.
           Tally answers altered=1 — which reads as success by every measure a
           caller has — and the voucher comes back ISCANCELLED=No. The flag is
           accepted and discarded. Anyone who reached for the intuitive shape
           would believe they had cancelled an invoice that is still live in the
           books and still in GSTR-1.
           Asserted as a known refusal so it stays visible and nobody tries it
           again from first principles. */
        ok("the ISCANCELLED flag is SILENTLY IGNORED — altered=1, still not cancelled",
          !cancelled,
          `ISCANCELLED=${fld(after[0], "ISCANCELLED")} after altered=${altered}`);
      } else {
        ok("Tally reports it as CANCELLED", cancelled,
          `ISCANCELLED=${fld(after[0], "ISCANCELLED")}`);
      }
    }
    H("C. THROUGH safePush — the path the app will actually take");
    {
      const number = `${TAG}/C`;
      const remoteId = `MKCP|Payment|${number}|2026-27`;
      const created = await post(subjectXml(company, number, remoteId, bank, party));
      const madeOk = (parseInt(fld(created, "CREATED") || "0", 10) || 0) === 1;
      ok(`${number} created`, madeOk, fld(created, "LINEERROR") || "created=1");
      if (madeOk) {
        made.push(remoteId);
        const res = await safePush(U, company, {
          remoteId, action: "Cancel", voucherType: "Payment", date: DATE,
          voucherNumber: number, partyLedgerName: party, isInvoice: false,
          ledgerEntries: [
            { ledgerName: party, amount: 100, isDeemedPositive: true, isPartyLedger: true },
            { ledgerName: bank, amount: 100, isDeemedPositive: false, isPartyLedger: false },
          ],
        });
        ok("safePush reports the cancel as done", res.ok,
          res.ok ? "guarded, cancelled and read back" : res.errors.join("; ").slice(0, 160));

        const after = mine(await vouchersToday(company), number);
        ok("and the books agree it is cancelled",
          after.length === 1 && /^yes$/i.test(fld(after[0], "ISCANCELLED")),
          after.length === 1 ? `ISCANCELLED=${fld(after[0], "ISCANCELLED")}` : `${after.length} found`);
      }

      // A cancel with no handle must be refused outright, never attempted: an
      // action against an unknown REMOTEID is how duplicates get made.
      const noId = await safePush(U, company, {
        action: "Cancel", voucherType: "Payment", date: DATE,
        voucherNumber: `${TAG}/NOID`, partyLedgerName: party, isInvoice: false,
        ledgerEntries: [
          { ledgerName: party, amount: 100, isDeemedPositive: true, isPartyLedger: true },
          { ledgerName: bank, amount: 100, isDeemedPositive: false, isPartyLedger: false },
        ],
      });
      ok("a cancel with no remoteId is refused by the guard",
        !noId.ok && noId.errors.some((e) => /requires a remoteId/i.test(e)),
        noId.errors.join("; ").slice(0, 120));
    }
  } finally {
    H("CLEANING UP");
    if (KEEP) {
      console.log(`    --keep: ${made.length} subject(s) left in place.`);
    } else {
      for (const rid of made) await remove(company, rid);
      const left = (await vouchersToday(company)).filter((v) => fld(v, "VOUCHERNUMBER").startsWith(TAG));
      ok("every probe voucher has been removed", left.length === 0,
        `${left.length} left: ${left.map((v) => fld(v, "VOUCHERNUMBER")).join(", ")}`);
    }
    const day1 = await vouchersToday(company);
    ok("the day's voucher count is back where it started",
      day1.filter((v) => !fld(v, "VOUCHERNUMBER").startsWith(TAG)).length === day0.length,
      `${day0.length} → ${day1.length}`);
  }

  console.log(`\n\x1b[1m${passed} passed · ${failed} failed\x1b[0m`);
  if (failed) console.log(`\nfailed:\n${failures.map((f) => `  · ${f}`).join("\n")}`);
  console.log();
  process.exit(failed ? 1 : 0);
})();
