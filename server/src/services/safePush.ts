/**
 * The only sanctioned way to write a voucher into Tally.
 *
 *   resolve masters → guard → build → push → READ BACK → diff → report
 *
 * The read-back is not optional. Tally accepts several kinds of wrong voucher
 * silently (a mistyped ledger, a unit that isn't the item's own), returning
 * CREATED=1 while the voucher lands incomplete. `CREATED=1` therefore proves
 * acceptance, never correctness — only a field-by-field diff of what Tally
 * actually stored does that.
 */
import { tallyPost } from "../tally.js";
import { buildVoucherImportXml, parseImportResponse, partyIdentity, type PartyIdentity } from "./voucherPusher.js";
import { loadMasters, gstRateFor, hsnFor, type TallyMasters } from "./tallyMasters.js";
import { guardVoucher, isInwardSupply, type GuardContext } from "./pushGuard.js";
import { loadOpenBills } from "./billSettlement.js";
import { nextFreeNumber, takenNumbers } from "./voucherNumbering.js";
import { withTally } from "./tallyGate.js";
import type { VoucherPayload, PushResult } from "../types.js";

export interface SafePushResult {
  ok: boolean;
  stage: "guard" | "push" | "verify" | "done";
  voucherId: string | null;
  errors: string[];
  warnings: string[];
  /** Fields Tally stored differently from what we sent. Empty means exact. */
  differences: string[];
  /** Kept for the audit trail — the exact bytes sent and Tally's verbatim reply. */
  requestXml?: string;
  responseXml?: string;
  pushResult?: PushResult;
}

const unesc = (s: string) => s
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
  .replace(/&amp;/g, "&");
const fld = (b: string, t: string) => {
  const m = new RegExp(`<${t}[^>]*>([^<]*)</${t}>`).exec(b);
  return m ? unesc(m[1].trim()) : "";
};
const lead = (s: string) => { const m = /^\s*(-?[\d.]+)/.exec(s.replace(/,/g, "")); return m ? parseFloat(m[1]) : NaN; };
/**
 * Sub-lists of a voucher, EMPTY ONES DROPPED.
 *
 * A Collection read-back emits placeholder `<ALLINVENTORYENTRIES.LIST></...>`
 * elements even on vouchers that carry no stock at all, so counting raw matches
 * reports a Receipt as having one stock line and fails an otherwise perfect
 * voucher. Only blocks with at least one populated tag are real.
 */
const listOf = (b: string, t: string) =>
  [...b.matchAll(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`, "g"))]
    .map(m => m[1])
    .filter(x => /<[A-Z0-9_.]+>[^<\s]/.test(x));
const r2 = (x: number) => Math.round(x * 100) / 100;
const signed = (a: number, dr: boolean) => r2(dr ? -Math.abs(a) : Math.abs(a));
const escXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Read back the vouchers for one date.
 *
 * Deliberately a Collection with a TDL date filter rather than the Day Book
 * report. Day Book on this install **ignores `SVFROMDATE`/`SVTODATE` entirely**
 * and always returns Tally's own current date — which silently broke read-back
 * the moment the calendar rolled past the date Tally was sitting on. A
 * verification step that can be defeated by a date change is not a verification
 * step.
 */
export function vouchersOnDateXml(company: string, isoDate: string): string {
  const stamp = parseInt(isoDate.replace(/-/g, ""), 10);
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>MkVerify</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${escXml(company)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE>
<COLLECTION NAME="MkVerify" ISMODIFY="No">
<TYPE>Voucher</TYPE>
<NATIVEMETHOD>Date</NATIVEMETHOD><NATIVEMETHOD>VoucherNumber</NATIVEMETHOD>
<NATIVEMETHOD>VoucherTypeName</NATIVEMETHOD><NATIVEMETHOD>Narration</NATIVEMETHOD>
<NATIVEMETHOD>PartyLedgerName</NATIVEMETHOD><NATIVEMETHOD>IsCancelled</NATIVEMETHOD>
<NATIVEMETHOD>AllLedgerEntries</NATIVEMETHOD><NATIVEMETHOD>LedgerEntries</NATIVEMETHOD>
<NATIVEMETHOD>AllInventoryEntries</NATIVEMETHOD>
<NATIVEMETHOD>Address</NATIVEMETHOD><NATIVEMETHOD>BasicBuyerAddress</NATIVEMETHOD>
<NATIVEMETHOD>PartyMailingName</NATIVEMETHOD><NATIVEMETHOD>ConsigneeMailingName</NATIVEMETHOD>
<NATIVEMETHOD>BasicBuyerName</NATIVEMETHOD><NATIVEMETHOD>PartyGSTIN</NATIVEMETHOD>
<NATIVEMETHOD>ConsigneeGSTIN</NATIVEMETHOD><NATIVEMETHOD>StateName</NATIVEMETHOD>
<NATIVEMETHOD>ConsigneeStateName</NATIVEMETHOD><NATIVEMETHOD>PlaceOfSupply</NATIVEMETHOD>
<NATIVEMETHOD>PartyPincode</NATIVEMETHOD><NATIVEMETHOD>ConsigneePinCode</NATIVEMETHOD>
<NATIVEMETHOD>CountryOfResidence</NATIVEMETHOD><NATIVEMETHOD>ConsigneeCountryName</NATIVEMETHOD>
<NATIVEMETHOD>GSTRegistrationType</NATIVEMETHOD>
<FILTER>MkVerifyDate</FILTER>
</COLLECTION>
<SYSTEM TYPE="Formulae" NAME="MkVerifyDate">($$YearOfDate:$Date * 10000 + $$MonthOfDate:$Date * 100 + $$DayOfDate:$Date) = ${stamp}</SYSTEM>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
}

/** Diff what Tally stored against what we intended to send. */
export function diffStored(p: VoucherPayload, v: string): string[] {
  const out: string[] = [];
  const eq = (a: number, b: number) => Math.abs(a - b) < 0.02;

  const stored = [...listOf(v, "LEDGERENTRIES\\.LIST"), ...listOf(v, "ALLLEDGERENTRIES\\.LIST")];
  for (const e of p.ledgerEntries ?? []) {
    // A line with an explicit signedAmount is emitted verbatim, so that is what
    // must come back — deriving the sign again would compare against a value
    // that was never sent.
    const want = e.signedAmount !== undefined ? e.signedAmount : signed(e.amount, e.isDeemedPositive);
    const hit = stored.find(x => fld(x, "LEDGERNAME") === e.ledgerName && eq(lead(fld(x, "AMOUNT")), want));
    if (!hit) {
      const named = stored.find(x => fld(x, "LEDGERNAME") === e.ledgerName);
      out.push(named
        ? `ledger "${e.ledgerName}": sent ${want}, stored ${lead(fld(named, "AMOUNT"))}`
        : `ledger "${e.ledgerName}": NOT STORED — Tally discarded it`);
      continue;
    }
    for (const b of e.billAllocations ?? []) {
      const bh = listOf(hit, "BILLALLOCATIONS\\.LIST").find(x => fld(x, "NAME") === b.name);
      if (!bh) { out.push(`bill ref "${b.name}" on "${e.ledgerName}": NOT STORED`); continue; }
      if (fld(bh, "BILLTYPE") !== b.billType) out.push(`bill "${b.name}": type sent ${b.billType}, stored ${fld(bh, "BILLTYPE")}`);
      if (!eq(lead(fld(bh, "AMOUNT")), signed(b.amount, e.isDeemedPositive))) out.push(`bill "${b.name}": amount mismatch`);
    }
    if (e.bankAllocation) {
      const ba = listOf(hit, "BANKALLOCATIONS\\.LIST").find(x => x.trim().length > 5);
      if (!ba) out.push(`bank instrument on "${e.ledgerName}": NOT STORED — Tally will prompt on this voucher`);
      else if (fld(ba, "INSTRUMENTNUMBER") !== e.bankAllocation.instrumentNumber)
        out.push(`bank UTR: sent "${e.bankAllocation.instrumentNumber}", stored "${fld(ba, "INSTRUMENTNUMBER")}"`);
    }
  }

  const inv = listOf(v, "ALLINVENTORYENTRIES\\.LIST");
  const sent = p.inventoryEntries ?? [];
  if (inv.length !== sent.length) out.push(`stock lines: sent ${sent.length}, stored ${inv.length}`);
  // Consume each stored line at most once. The same item legitimately appears
  // twice on one bill (two rates, two batches); matching by name alone compared
  // both sent lines against the first stored one and reported a false mismatch.
  const unclaimed = [...inv];
  for (const l of sent) {
    const want = signed(l.amount, l.isDeemedPositive);
    let idx = unclaimed.findIndex(x => fld(x, "STOCKITEMNAME") === l.stockItemName && eq(lead(fld(x, "AMOUNT")), want));
    if (idx < 0) idx = unclaimed.findIndex(x => fld(x, "STOCKITEMNAME") === l.stockItemName);
    const hit = idx >= 0 ? unclaimed.splice(idx, 1)[0] : undefined;
    if (!hit) { out.push(`item "${l.stockItemName}": NOT STORED`); continue; }
    if (!eq(lead(fld(hit, "AMOUNT")), signed(l.amount, l.isDeemedPositive)))
      out.push(`item "${l.stockItemName}": amount sent ${signed(l.amount, l.isDeemedPositive)}, stored ${lead(fld(hit, "AMOUNT"))}`);
    // A voided quantity is the signature of a wrong unit token.
    if (!eq(lead(fld(hit, "ACTUALQTY")), l.quantity))
      out.push(`item "${l.stockItemName}": qty sent ${l.quantity}, stored "${fld(hit, "ACTUALQTY")}"`);
    if (!eq(lead(fld(hit, "RATE")), l.rate))
      out.push(`item "${l.stockItemName}": rate sent ${l.rate}, stored "${fld(hit, "RATE")}"`);
    if (l.godownName && fld(hit, "GODOWNNAME") !== l.godownName)
      out.push(`item "${l.stockItemName}": godown not stored`);
    if (l.salesLedgerName && !listOf(hit, "ACCOUNTINGALLOCATIONS\\.LIST").some(a => fld(a, "LEDGERNAME") === l.salesLedgerName))
      out.push(`item "${l.stockItemName}": accounting ledger "${l.salesLedgerName}" NOT STORED — the posting is missing`);
  }
  return out;
}

/**
 * Did Tally store the bill-to / ship-to / GST identity we sent — and did every
 * stock line keep its GST rate?
 *
 * `diffStored` compares money and stock. It is blind to identity, which is how
 * three silent failures got through: no GST identity block (Sep-11), no party
 * address (Sep-19), and on 23-Sep an empty ship-to that broke the e-way bill
 * while every check passed. The owner's words: these "cannot be broken at any
 * point". So a voucher whose stored identity differs from what we sent now
 * fails verification here, on every push, not in a harness someone has to
 * remember to run.
 *
 * Compares against `partyIdentity` — the same value the builder rendered — so
 * the check can never drift from the build. Lines: each stock line we sent a
 * rate for must come back with that IGST rate on its RATEDETAILS.
 */
export function diffIdentity(p: VoucherPayload, masters: TallyMasters, v: string, sent?: PartyIdentity | null): string[] {
  const id = sent === undefined ? partyIdentity(p, masters) : sent;
  if (!id) return [];
  const out: string[] = [];
  const header = v
    .replace(/<ALLINVENTORYENTRIES\.LIST>[\s\S]*?<\/ALLINVENTORYENTRIES\.LIST>/g, "")
    .replace(/<INVENTORYENTRIES\.LIST>[\s\S]*?<\/INVENTORYENTRIES\.LIST>/g, "")
    .replace(/<ALLLEDGERENTRIES\.LIST>[\s\S]*?<\/ALLLEDGERENTRIES\.LIST>/g, "")
    .replace(/<LEDGERENTRIES\.LIST>[\s\S]*?<\/LEDGERENTRIES\.LIST>/g, "")
    .replace(/<EWAYBILLDETAILS\.LIST>[\s\S]*?<\/EWAYBILLDETAILS\.LIST>/g, "");
  const lines = (t: string) => [...header.matchAll(new RegExp(`<${t}\\.LIST[^>]*>([\\s\\S]*?)</${t}\\.LIST>`, "g"))]
    .flatMap(b => [...b[1].matchAll(new RegExp(`<${t}>([^<]*)</${t}>`, "g"))].map(x => unesc(x[1].trim())))
    .filter(Boolean);
  const same = (label: string, want: string, got: string) => {
    if (want.trim() !== got.trim()) out.push(`${label}: sent "${want}", stored "${got}"`);
  };
  same("bill-to name (PARTYMAILINGNAME)", id.mailingName, fld(header, "PARTYMAILINGNAME"));
  same("bill-to address", id.address.join(" | "), lines("ADDRESS").join(" | "));
  same("bill-to GSTIN", id.gstin, fld(header, "PARTYGSTIN"));
  same("bill-to state", id.state, fld(header, "STATENAME"));
  same("bill-to pincode", id.pincode, fld(header, "PARTYPINCODE"));
  same("place of supply", id.placeOfSupply, fld(header, "PLACEOFSUPPLY"));
  same("registration type", id.registrationType, fld(header, "GSTREGISTRATIONTYPE"));
  same("ship-to ledger (BASICBUYERNAME)", id.consigneeLedger, fld(header, "BASICBUYERNAME"));
  same("ship-to name", id.consignee.mailingName, fld(header, "CONSIGNEEMAILINGNAME"));
  same("ship-to address", id.consignee.address.join(" | "), lines("BASICBUYERADDRESS").join(" | "));
  same("ship-to GSTIN", id.consignee.gstin, fld(header, "CONSIGNEEGSTIN"));
  same("ship-to state", id.consignee.state, fld(header, "CONSIGNEESTATENAME"));
  same("ship-to pincode", id.consignee.pincode, fld(header, "CONSIGNEEPINCODE"));
  same("ship-to country", id.consignee.country, fld(header, "CONSIGNEECOUNTRYNAME"));

  // Line rates. Only lines we sent a rate for (outward, rate resolved).
  const stored = [...v.matchAll(/<ALLINVENTORYENTRIES\.LIST>([\s\S]*?)<\/ALLINVENTORYENTRIES\.LIST>/g)].map(m => m[1]);
  // Inward lines are built without rate details (buildVoucherImportXml passes
  // no masters to them), so there is nothing of ours to compare.
  for (const l of isInwardSupply(p.voucherType) ? [] : p.inventoryEntries ?? []) {
    const want = gstRateFor(masters, l.stockItemName, p.date).rate;
    if (!(want > 0)) continue;
    const blk = stored.find(b => fld(b, "STOCKITEMNAME") === l.stockItemName);
    if (!blk) continue;   // diffStored already reports a missing line
    const own = blk.replace(/<ACCOUNTINGALLOCATIONS\.LIST>[\s\S]*?<\/ACCOUNTINGALLOCATIONS\.LIST>/g, "");
    const igst = [...own.matchAll(/<RATEDETAILS\.LIST>([\s\S]*?)<\/RATEDETAILS\.LIST>/g)]
      .map(m => m[1]).find(b => fld(b, "GSTRATEDUTYHEAD") === "IGST");
    const got = igst ? lead(fld(igst, "GSTRATE")) : NaN;
    if (!(Math.abs(got - want) < 0.001)) {
      out.push(`item "${l.stockItemName}": GST rate sent ${want}%, stored ${Number.isNaN(got) ? "none — Tally will file it as 'Tax rate not specified'" : `${got}%`}`);
    }
    if (hsnFor(masters, l.stockItemName, p.date).code && !fld(own, "GSTHSNNAME")) out.push(`item "${l.stockItemName}": no HSN stored on the line`);
  }
  return out;
}

export async function safePush(
  tallyUrl: string,
  company: string,
  payload: VoucherPayload,
  opts: { verify?: boolean } = {},
  /** Set only by the one recovery below, so it can never recurse twice. */
  retriedWithoutNumber = false,
): Promise<SafePushResult> {
  const verify = opts.verify !== false;

  // ── 1. Guard ──────────────────────────────────────────────────────────────
  let masters = await loadMasters(tallyUrl, company);
  /* An Agst Ref is checked against Tally's own open bills BEFORE the push:
     Tally rewrites one that is not open for this party as a New Ref and
     reports success (TG-P20). Same Bills read bulkEntry already uses live.
     Loaded only when the voucher carries one — it is a full-book read. */
  const ctx: GuardContext = {};
  const hasAgstRef = (payload.ledgerEntries ?? []).some(e => (e.billAllocations ?? []).some(b => b.billType === "Agst Ref"));
  if (hasAgstRef && (payload.action ?? "Create") === "Create") {
    try { ctx.openBills = await loadOpenBills(tallyUrl, company); }
    catch (e) { console.warn(`[safePush] open bills could not be read (${(e as Error).message}) — the Agst Ref check falls back to the read-back.`); }
  }
  let guard = guardVoucher(payload, masters, ctx);

  // The master cache has a ten-minute TTL, so a ledger or item created in Tally
  // moments ago is not in it yet and the guard rejects the voucher as "does not
  // exist". That window sits squarely inside the busiest hour of the day, when
  // a party is most likely to be created mid-flow. A missing-master rejection is
  // therefore worth one forced reload before it is believed.
  if (!guard.ok && guard.errors.some(e => /does not exist/i.test(e))) {
    masters = await loadMasters(tallyUrl, company, { force: true });
    const retried = guardVoucher(payload, masters, ctx);
    if (retried.ok) console.warn("[safePush] a master was missing from the cache; reloaded and the voucher now passes.");
    guard = retried;
  }

  if (!guard.ok) {
    return { ok: false, stage: "guard", voucherId: null, errors: guard.errors, warnings: guard.warnings, differences: [] };
  }
  for (const w of guard.warnings) console.warn(`[safePush] ${w}`);

  // ── 2. Build, and prove it is well-formed before it leaves the process.
  //      A malformed body makes Tally throw a modal that blocks its XML port
  //      until the application is restarted. ───────────────────────────────────
  let xml: string;
  try {
    // Masters carry the party's GST identity. Without them the voucher imports
    // cleanly but lands in the GSTR-1 exception bucket rather than B2B supplies.
    xml = buildVoucherImportXml(company, payload, masters);
  } catch (e) {
    return { ok: false, stage: "guard", voucherId: null, errors: [(e as Error).message], warnings: guard.warnings, differences: [] };
  }
  const wellFormed = checkWellFormed(xml);
  if (wellFormed) {
    return { ok: false, stage: "guard", voucherId: null, errors: [`Generated XML is malformed: ${wellFormed}`], warnings: guard.warnings, differences: [] };
  }

  // ── 3. Push ───────────────────────────────────────────────────────────────
  // Every write goes through the gate: one at a time, and refused outright if
  // a previous request left Tally behind a dialog. Two concurrent requests on a
  // single-threaded port is how a hang starts.
  const responseXml: string = await withTally(tallyUrl, `push ${payload.voucherType} ${payload.voucherNumber ?? ""}`,
    () => tallyPost(tallyUrl, xml, 60_000, true) as Promise<string>);
  const result = parseImportResponse(responseXml);
  const count = (tag: string) => parseInt(new RegExp(`<${tag}>\\s*(\\d+)\\s*</${tag}>`).exec(responseXml)?.[1] ?? "0", 10);
  const exceptions = count("EXCEPTIONS");

  // Alter and Delete report on their own counters, not CREATED. Watch for the
  // dangerous case too: an Alter that comes back as a CREATE means Tally could
  // not find the voucher and made a duplicate instead of changing it.
  const action = payload.action ?? "Create";
  if (action === "Alter" && count("CREATED") > 0 && count("ALTERED") === 0) {
    return { ok: false, stage: "push", voucherId: null,
      errors: [`Asked Tally to ALTER, but it CREATED a duplicate instead — it could not find a voucher with remoteId "${payload.remoteId}". The duplicate is now in the books and needs removing.`],
      warnings: guard.warnings, differences: [], requestXml: xml, responseXml, pushResult: result };
  }
  // The mirror image of the trap above, and a false NEGATIVE rather than a false
  // positive: a Create whose REMOTEID already exists comes back
  // CREATED=0 ALTERED=1. Tally updated the existing voucher instead of making a
  // second one — which is precisely the idempotency a stable remoteId is for.
  // Reading that as a rejection makes the queue retry a voucher that is already
  // correctly in the books, and every retry "fails" the same way until the job
  // is marked failed.
  const createBecameAlter = action === "Create" && count("CREATED") === 0 && count("ALTERED") > 0;
  if (createBecameAlter) {
    console.warn(`[safePush] "${payload.voucherNumber ?? payload.remoteId}" already existed under this remoteId — Tally updated it rather than creating a duplicate.`);
  }

  const succeeded =
    // Cancel comes back as an alteration, not as its own count.
    action === "Alter" || action === "Cancel" ? count("ALTERED") > 0 :
    action === "Delete" ? count("DELETED") > 0 :
    result.success || createBecameAlter;

  if (action === "Delete") {
    return { ok: succeeded && exceptions === 0 && count("ERRORS") === 0,
      stage: succeeded ? "done" : "push", voucherId: null,
      errors: succeeded ? [] : [result.lineErrors[0] ?? `Delete failed — deleted=${count("DELETED")} errors=${count("ERRORS")}.`],
      warnings: guard.warnings, differences: [], requestXml: xml, responseXml, pushResult: result };
  }

  /* ── One recovery, and only one: find a number that is FREE ─────────────
     A rejection that looks like a taken number gets ONE more push, carrying
     the next free number in the same series rather than the one that bounced.

     WHAT WAS TRIED FIRST AND IS WRONG. The obvious cure is to drop the number
     and let Tally assign one — Payment, Receipt, Contra and Sales are all
     configured "Automatic (Manual Override)" in this company, which says
     exactly that. Measured against a real company, 17-Sep-2026, four pushes:

       fresh number            created=1  exceptions=0
       the SAME number again   created=0  exceptions=1   the operator's bug
       the number OMITTED      created=0  exceptions=1   the "obvious" cure
       the NEXT free number    created=1  exceptions=0   the real one

     Tally does not auto-number a voucher arriving over XML. Auto-numbering is
     a behaviour of interactive entry, and a recovery built on it would have
     traded one silent failure for another.

     Three conditions make the retry safe rather than a gamble:

       created=0   Tally states it wrote nothing, so a second attempt cannot
                   duplicate. This is the ONLY exception to pushAgent's refusal
                   to retry, and it is why that rule can stay strict elsewhere.
       Create only an Alter/Cancel/Delete without its own number is a different
                   instruction, not the same one retried.
       once        a second refusal means the number was never the problem, and
                   the ORIGINAL error is what the operator needs to see.

     REMOTEID is untouched. It is derived from the number we ASKED for, not the
     one that lands, so identity survives and the voucher stays correctable —
     which matters more than usual here, because the REMOTEID is WRITE-ONLY.
     MASTERID, VOUCHERKEY and GUID were each tried as a delete handle and every
     one answered deleted=0 with no error; a voucher whose REMOTEID is not
     recorded can never be altered or removed again. */
  const numberMayBeTaken =
    !succeeded && exceptions > 0 && count("CREATED") === 0 &&
    action === "Create" && !!payload.voucherNumber && !retriedWithoutNumber;

  if (numberMayBeTaken) {
    const taken = await withTally(tallyUrl, `list ${payload.voucherType} numbers`,
      () => takenNumbers(tallyUrl, company, payload.voucherType));
    const free = nextFreeNumber(taken, payload.voucherNumber!);
    if (!free) {
      console.warn(`[safePush] "${payload.voucherNumber}" was refused and no free number could be worked out for ${payload.voucherType} — reporting the original rejection.`);
    } else {
      console.warn(`[safePush] "${payload.voucherNumber}" was refused with nothing created — retrying once as "${free}".`);
      const again = await safePush(tallyUrl, company, { ...payload, voucherNumber: free }, opts, true);
      if (again.ok) {
        return {
          ...again,
          warnings: [
            ...again.warnings,
            `"${payload.voucherNumber}" was already taken in Tally, so this voucher was numbered "${free}" instead. Re-sync to see it.`,
          ],
        };
      }
      // The number was not the problem. Report the ORIGINAL rejection.
    }
  }

  if (!succeeded || exceptions > 0) {
    return {
      ok: false, stage: "push", voucherId: null,
      // Never auto-retry: an exception is structural, and a retry risks a
      // duplicate. pushAgent honours this now — it used to retry five times.
      errors: result.lineErrors.length ? result.lineErrors
        : [`Tally rejected the voucher — created=${result.created} errors=${result.errors} exceptions=${exceptions}, with no reason given.`
          + (payload.voucherNumber ? duplicateNumberHint(payload.voucherNumber) : "")],
      warnings: guard.warnings, differences: [], requestXml: xml, responseXml, pushResult: result,
    };
  }

  if (!verify) {
    return { ok: true, stage: "done", voucherId: result.lastVoucherId, errors: [], warnings: guard.warnings,
      differences: [], requestXml: xml, responseXml, pushResult: result };
  }

  // ── 4. Read it back ───────────────────────────────────────────────────────
  const book: string = await withTally(tallyUrl, `verify ${payload.voucherNumber ?? ""}`,
    () => tallyPost(tallyUrl, vouchersOnDateXml(company, payload.date), 180_000, true) as Promise<string>);
  const vouchers = [...book.matchAll(/<VOUCHER\b[^>]*>[\s\S]*?<\/VOUCHER>/g)].map(m => m[0]);
  // Match on voucher number first. Journal is configured with numbering "None"
  // in this company, so Tally stores no number at all however good the one we
  // sent — a number-only match reports a perfectly good Journal as missing.
  let mine = payload.voucherNumber
    ? vouchers.find(x => fld(x, "VOUCHERNUMBER") === payload.voucherNumber)
    : undefined;

  if (!mine && payload.narration) {
    // Falling back to narration is only safe when it identifies ONE voucher.
    // Narrations repeat constantly in real books ("AS PER BILL" is on hundreds),
    // and comparing against an arbitrary one of several silently reports another
    // voucher's figures as this voucher's — worse than admitting we cannot tell.
    const byNarration = vouchers.filter(x => fld(x, "NARRATION") === payload.narration);
    if (byNarration.length === 1) mine = byNarration[0];
    else if (byNarration.length > 1) {
      return { ok: false, stage: "verify", voucherId: result.lastVoucherId,
        errors: [`Created (id ${result.lastVoucherId}) but could not be verified: it carries no voucher number and ${byNarration.length} vouchers on ${payload.date} share the narration "${payload.narration}". Give it a unique number or narration to make it verifiable.`],
        warnings: guard.warnings, differences: [], requestXml: xml, responseXml, pushResult: result };
    }
  }

  if (!mine) {
    /* Last resort: the party and the exact money.
       Added ONLY as a fallback beneath the two above, so it can never change
       how a numbered voucher is matched — it can only turn "not found" into
       "found". It exists because a voucher whose number Tally chose has no
       number of ours to match on, and money narrations are not unique: this
       house writes "AS PER VOUCHER" on hundreds of them.
       Same rule as the narration branch — ONE candidate or none. Two payments
       to one party on one day for the same amount are genuinely
       indistinguishable from outside, and guessing between them would report
       the other voucher's figures as this one's. */
    const byMoney = vouchers.filter(
      (x) =>
        fld(x, "VOUCHERTYPENAME") === payload.voucherType &&
        fld(x, "PARTYLEDGERNAME") === payload.partyLedgerName &&
        diffStored(payload, x).length === 0,
    );
    if (byMoney.length === 1) mine = byMoney[0];
  }

  if (!mine) {
    return { ok: false, stage: "verify", voucherId: result.lastVoucherId,
      errors: [`Tally reported the voucher created (id ${result.lastVoucherId}) but it could not be found on read-back.`],
      warnings: guard.warnings, differences: [], requestXml: xml, responseXml, pushResult: result };
  }

  /* A CANCEL IS VERIFIED BY THE STORED FLAG, NEVER BY THE RESPONSE.
     `ACTION="Alter"` carrying <ISCANCELLED>Yes</ISCANCELLED> returns altered=1
     and leaves the voucher ISCANCELLED=No — accepted and discarded (proved in
     scripts/test-cancel-voucher.ts). Only `ACTION="Cancel"` does anything,
     and the two are indistinguishable from the response alone. So this reads
     the flag back rather than trusting a count.

     Diffing the fields would be wrong here as well: a cancelled voucher keeps
     its number and its place in the sequence but is no longer a posting, so it
     is SUPPOSED to differ from the payload that addressed it. */
  if (action === "Cancel") {
    const isCancelled = /^yes$/i.test(fld(mine, "ISCANCELLED"));
    return {
      ok: isCancelled,
      stage: isCancelled ? "done" : "verify",
      voucherId: result.lastVoucherId,
      errors: isCancelled ? [] : [
        `Tally reported the cancel as applied, but the voucher reads back ISCANCELLED="${fld(mine, "ISCANCELLED") || "(absent)"}". It is still a live posting and still in GSTR-1.`,
      ],
      warnings: guard.warnings, differences: [], requestXml: xml, responseXml, pushResult: result,
    };
  }

  const differences = [...diffStored(payload, mine), ...diffIdentity(payload, masters, mine)];
  return {
    ok: differences.length === 0,
    stage: differences.length ? "verify" : "done",
    voucherId: result.lastVoucherId,
    errors: differences.length ? [`Stored voucher differs from what was sent in ${differences.length} place(s).`] : [],
    warnings: guard.warnings,
    differences, requestXml: xml, responseXml, pushResult: result,
  };
}

/** Minimal well-formedness check — returns a message, or null when fine. */
function checkWellFormed(xml: string): string | null {
  const stack: string[] = [];
  const re = /<(\/?)([A-Za-z0-9_.:]+)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const [, close, tag, , selfClose] = m;
    if (selfClose) continue;
    if (close) {
      const open = stack.pop();
      if (open !== tag) return `</${tag}> closes <${open ?? "nothing"}>`;
    } else stack.push(tag);
  }
  if (stack.length) return `unclosed <${stack[stack.length - 1]}>`;
  // A bare & that isn't an entity breaks Tally's parser for the WHOLE file.
  const bad = /&(?!amp;|lt;|gt;|quot;|apos;|#\d+;)/.exec(xml);
  if (bad) return `unescaped "&" at offset ${bad.index}`;
  return null;
}


/**
 * What an unexplained `exceptions=1` almost always means, said usefully.
 *
 * Tally gives no reason, so this is an inference — but not a shrug. Three live
 * cases this week were all the same thing, and all on the same series:
 * Payments "1852/26-27", "1853/26-27" and "1867/26-27" rejected while
 * "CHQ-544..547/26-27" went through untouched.
 *
 * The mechanism is a RACE, not staleness alone. The app picks the next number
 * by reading the mirror, and the operator also types vouchers straight into
 * Tally, which takes numbers from the same series. 1852 and 1853 turned out to
 * be cash payments dated 12-Sep — entered in Tally, backdated, so nothing
 * re-read that day and the mirror never saw them. By the time the app asked,
 * the numbers were gone.
 *
 * A fresher mirror narrows that window; it cannot close it, because the two
 * issuers share one series. The durable fixes are to let Tally number these
 * itself, or to give the app a series of its own — and choosing between them
 * needs to be checked against the numbering method set on the voucher type in
 * Tally, which is not knowable from here.
 */
function duplicateNumberHint(voucherNumber: string): string {
  return ` Tally almost certainly already holds a voucher numbered "${voucherNumber}"` +
    ` — created=0 means nothing was written, so nothing is duplicated in the books.` +
    ` The number was taken from the mirror, and a voucher entered directly in Tally` +
    ` (especially a backdated one) claims it first. Re-sync, then push again with the next free number.`;
}
