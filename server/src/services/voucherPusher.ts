import type { VoucherPayload, LedgerEntry, InventoryEntry, BillAllocation, PushResult } from "../types.js";
import { tallyPost } from "../tally.js";
import { findLedger, registrationOn, type TallyMasters } from "./tallyMasters.js";
import { HOME_STATE_NAME, isInwardSupply, resolvePartyState } from "./pushGuard.js";
import { XMLParser } from "fast-xml-parser";

const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: true });

// Patterns for voucher types whose balance is on the inventory side, not ledger entries.
// Match case-insensitively because companies can rename them (e.g. "DELIVERY NOTE").
function isInventoryVoucherType(vt: string): boolean {
  const u = vt.trim().toUpperCase();
  return u.includes("DELIVERY") || u.includes("RECEIPT NOTE");
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** YYYY-MM-DD → YYYYMMDD */
function toVoucherDate(date: string): string {
  return date.replace(/-/g, "");
}

/** Format amount for Tally: Debit (isDeemedPositive=true) → negative, Credit → positive */
function tallyAmount(amount: number, isDeemedPositive: boolean): string {
  const signed = isDeemedPositive ? -Math.abs(amount) : Math.abs(amount);
  return signed.toFixed(2);
}

/**
 * Determine the correct OBJVIEW for a voucher.
 * Each voucher type has its own persistent view in TallyPrime.
 */
function getObjView(voucherType: string, isInvoice: boolean, hasInventory: boolean): string {
  const u = voucherType.trim().toUpperCase();
  if (u.includes("DELIVERY")) return "Delivery Note Voucher View";
  if (u.includes("RECEIPT NOTE")) return "Receipt Note Voucher View";
  return isInvoice && hasInventory ? "Invoice Voucher View" : "Accounting Voucher View";
}

/**
 * Bill allocations: AMOUNT sign must match the parent ledger entry's side.
 * isDeemedPositive=true (Dr) → negative amount; false (Cr) → positive amount.
 */
function buildBillAllocations(allocs: BillAllocation[], isDeemedPositive: boolean): string {
  return allocs.map(b => `
    <BILLALLOCATIONS.LIST>
      <NAME>${esc(b.name)}</NAME>
      <BILLTYPE>${esc(b.billType)}</BILLTYPE>
      <AMOUNT>${tallyAmount(b.amount, isDeemedPositive)}</AMOUNT>
    </BILLALLOCATIONS.LIST>`).join("");
}

/**
 * Is this voucher invoice-SHAPED — party and tax in LEDGERENTRIES, goods in
 * ALLINVENTORYENTRIES with their own accounting allocation?
 *
 * Not the same question as `isInvoice`. A **Sales Order Note carries
 * ISINVOICE=No yet is invoice-shaped**: it reserves stock rather than moving it,
 * but still uses LEDGERENTRIES and stock lines. Keying off `isInvoice` alone
 * emits the wrong tag for it and makes the balance check ignore the stock side.
 */
export function isInvoiceShaped(p: VoucherPayload): boolean {
  if (p.isInvoice) return true;
  return (p.inventoryEntries ?? []).some(e => !!e.salesLedgerName);
}

/**
 * Invoice-shaped vouchers carry their ledger lines in LEDGERENTRIES.LIST;
 * accounting-mode ones (Payment/Receipt/Journal/Contra) use
 * ALLLEDGERENTRIES.LIST. Tally silently IGNORES the wrong one — an invoice sent
 * with ALLLEDGERENTRIES imports with its party line missing and comes back as
 * EXCEPTIONS=1, CREATED=0, with no message naming the cause. Verified against a
 * full Day Book export: every Sales, Purchase and Sales Order uses
 * LEDGERENTRIES, every Payment and Receipt uses ALLLEDGERENTRIES, no overlap.
 */
/**
 * Bank instrument block. Omitting it makes Tally prompt for allocation on every
 * voucher that touches a bank ledger, which blocks unattended pushes.
 */
function buildBankAllocation(b: NonNullable<LedgerEntry["bankAllocation"]>, amount: number, isDeemedPositive: boolean, voucherDate: string): string {
  const d = (b.instrumentDate ?? voucherDate).replace(/-/g, "");
  return `
    <BANKALLOCATIONS.LIST>
      <DATE>${d}</DATE>
      <INSTRUMENTDATE>${d}</INSTRUMENTDATE>
      <BANKERSDATE>${d}</BANKERSDATE>
      <TRANSACTIONTYPE>${esc(b.transactionType)}</TRANSACTIONTYPE>
      <TRANSFERMODE>${esc(b.transferMode)}</TRANSFERMODE>
      <INSTRUMENTNUMBER>${esc(b.instrumentNumber)}</INSTRUMENTNUMBER>
      <PAYMENTFAVOURING>${esc(b.favouring)}</PAYMENTFAVOURING>
      <BANKPARTYNAME>${esc(b.favouring)}</BANKPARTYNAME>
      <PAYMENTMODE>Transacted</PAYMENTMODE>
      <STATUS>No</STATUS>
      <AMOUNT>${tallyAmount(amount, isDeemedPositive)}</AMOUNT>
    </BANKALLOCATIONS.LIST>`;
}

/**
 * The party's GST identity on the voucher.
 *
 * Without this block Tally cannot classify the supply, and the voucher lands in
 * GSTR-1 under **"Transactions with Incomplete/Mismatch in Information → GST
 * Registration Details of the Party are invalid or not specified"** rather than
 * in B2B supplies. The amounts are right and the voucher looks fine in the day
 * book — it simply would not file. Found in the operator's own GSTR-1 on
 * 2026-09-11, after every push-path test had passed: the read-back diff checks
 * ledger amounts, bill allocations and stock, none of which notice this.
 *
 * Everything here comes from the ledger master, which already carries it —
 * 163 of 237 debtors have a GSTIN on file. A party with no GSTIN is legitimately
 * unregistered and is marked as such rather than left blank, which is a
 * different (and valid) GSTR-1 category.
 */
function buildGstIdentity(p: VoucherPayload, masters?: TallyMasters): string {
  if (!masters) return "";
  // Money vouchers carry NO GST identity, and that is correct rather than a gap:
  // they never enter GSTR-1. Measured across 3,335 native FY26-27 vouchers,
  // Tally's own Payments, Contras and Journals carry a GSTIN 0% of the time,
  // while Purchases carry one 88% of the time and Sales 37% (the rest being
  // cash sales to unregistered walk-ins).
  //
  // This block used to be emitted unconditionally, so a Payment pushed from here
  // came back stamped with the supplier's GSTIN and place of supply — a shape
  // Tally itself never writes. It did not make the voucher wrong on the money,
  // but it made every pushed money voucher structurally distinguishable from a
  // hand-entered one, which is the kind of divergence that surfaces later as an
  // unexplained line in a return.
  if (!isInvoiceShaped(p)) return "";
  const party = findLedger(masters, p.partyLedgerName);
  // A name the masters don't know is the guard's problem, not this function's —
  // it rejects the voucher before the build. Emit nothing rather than guess.
  if (!party || "miss" in party) return "";

  // Use the registration in force on THIS voucher's date, not today's. A party's
  // GSTIN and place of supply are dated in Tally, and 61% of vouchers here are
  // backdated — taking the current one would stamp an old invoice with a
  // registration that did not apply when it was raised.
  const reg = registrationOn(party, p.date);
  const gstin = reg.gstin.trim();
  // The counterparty's state, which the payload may supply when the ledger has
  // none — the shared `Cash` ledger of a counter sale. The guard has already
  // refused anything where that stand-in is not legitimate, and both read the
  // SAME resolver so the voucher is stamped with exactly what was approved.
  const state = resolvePartyState(p, (reg.placeOfSupply || reg.state).trim()).state;

  /**
   * Place of supply is the DESTINATION of the goods, so it depends on which way
   * they are moving — it is not simply "the other party's state".
   *
   *   outward (Sales, Credit Note, Sales Order, Delivery Note)
   *       goods go TO the buyer      → place of supply = the PARTY's state
   *   inward (Purchase, Debit Note, Receipt Note)
   *       goods come TO us           → place of supply = OUR state
   *
   * `STATENAME` is the counterparty's state either way.
   *
   * Confirmed against Tally's own vouchers: a native purchase from a Delhi
   * supplier stores PLACEOFSUPPLY "West Bengal" with STATENAME "Delhi", while a
   * native sale to a West Bengal buyer stores both as "West Bengal".
   *
   * This function used to set both to the party's state, which is right for a
   * sale and wrong for every inter-state purchase — it declared the supply as
   * having happened in the supplier's state. The tax heads still came out as
   * IGST because those are chosen separately, so the voucher balanced, verified
   * and looked correct; only the return would have disagreed.
   */
  const placeOfSupply = isInwardSupply(p.voucherType) ? HOME_STATE_NAME : state;

  /* A typed buyer overrides the LEDGER's mailing name.
     On a counter sale the ledger is the shared `Cash`, whose mailing name is
     literally "Cash" — so without this the invoice is addressed to nobody even
     when the operator has typed the customer's name in. Where no buyer is
     given this is unchanged, and a sale to a real party keeps its master's
     mailing name, which is the one thing that must not be overridden. */
  const mailing = p.buyerName?.trim() || (party.mailingName ?? "").trim() || party.name;
  const pincode = (party.pincode ?? "").trim();
  const registered = gstin.length > 0;

  const tag = (t: string, v: string) => (v ? `\n            <${t}>${esc(v)}</${t}>` : "");

  return [
    // Tally's own word for the registration type on that date, when it has one —
    // "Regular", "Composition", "Unregistered" are not interchangeable.
    `\n            <GSTREGISTRATIONTYPE>${esc(reg.registrationType || (registered ? "Regular" : "Unregistered"))}</GSTREGISTRATIONTYPE>`,
    registered ? "" : `\n            <VATDEALERTYPE>Unregistered</VATDEALERTYPE>`,
    tag("PARTYGSTIN", gstin),
    // Destination of the goods — see the note above on why this is not always
    // the party's state.
    tag("PLACEOFSUPPLY", placeOfSupply),
    // The counterparty's state, whichever direction the goods move.
    tag("STATENAME", state),
    `\n            <COUNTRYOFRESIDENCE>India</COUNTRYOFRESIDENCE>`,
    tag("PARTYMAILINGNAME", mailing),
    /* The party's postal address, which this block built everything EXCEPT
     * until 17-Sep-2026.
     *
     * The owner pushed a purchase from K.W.Engineering Works (Regd.) and sent
     * a screenshot of Tally's Party Details: Mailing Name, State, Country,
     * Pincode, Registration type, GSTIN and Place of Supply all populated —
     * every one of them from the list above — and **Address blank**.
     *
     * It was never missing data. `TallyMasters.address` is fetched from the
     * ledger, parsed into a string[] and sat in the struct unread
     * (`tallyMasters.ts`), which is guardrail G4 in its purest form: a field
     * fetched, stored, and dropped at the last step. The FILE export path
     * emitted it from the bundled vendor master all along, so the same bill
     * carried an address or not depending on which button was pressed — the
     * identical divergence as `<REFERENCEDATE>` two days earlier, in the same
     * function, and it was not looked for then.
     *
     * Every line the master holds is emitted. The file path caps at two, which
     * is a display convention rather than a data one; this is a round-trip of
     * what Tally itself stores against that ledger, so truncating it here
     * would invent a difference rather than remove one. */
    /* ONE address emitter, not two.
     *
     * A counter sale bills the shared `Cash` ledger, which holds no address of
     * its own, so the lines an operator typed for the walk-in are the only ones
     * there are — and they belong in the SAME block a registered party's
     * address uses, because that is the block Tally prints from. An earlier
     * draft emitted the typed address from a second builder, which would have
     * put two <ADDRESS.LIST> blocks on any voucher whose ledger carried one
     * too. */
    addressFor(p, party).length
      ? `\n            <ADDRESS.LIST TYPE="String">${addressFor(p, party)
          .map((a) => `<ADDRESS>${esc(a)}</ADDRESS>`)
          .join("")}</ADDRESS.LIST>`
      : "",
    tag("PARTYPINCODE", pincode),
    // Consignee defaults to the buyer; this company does not ship to third
    // parties, and a blank consignee is itself a GSTR-1 exception.
    tag("CONSIGNEEGSTIN", gstin),
    tag("CONSIGNEESTATENAME", state),
    tag("CONSIGNEEMAILINGNAME", mailing),
    tag("CONSIGNEEPINCODE", pincode),
  ].join("");
}


/**
 * Which address lines the voucher carries — the typed buyer's, or the ledger's.
 *
 * ── Corrected 18-Sep-2026, against 413 real counter sales ─────────────────
 * The first attempt at this was modelled on ONE voucher (26-27/0657) and got
 * the shape backwards. That voucher is billed to a registered dealer's own
 * ledger; a counter sale is a different animal. Reading every Sales voucher in
 * these books whose PARTYLEDGERNAME is `Cash` settles it — 403 of the 413 name
 * their customer, and they all name them the same way:
 *
 *   PARTYNAME ............ Cash    ┐ all three stay the LEDGER; nobody
 *   BASICBUYERNAME ....... Cash    │ retypes them, and Tally fills them
 *   BASICBASEPARTYNAME ... Cash    ┘ from PARTYLEDGERNAME
 *   PARTYMAILINGNAME ..... CYCLE TRADERS   ← the customer
 *   ADDRESS.LIST ......... ["JHALDAH"]     ← their address
 *   BASICBUYERADDRESS .... (empty on all 413)
 *
 * So the name rides on PARTYMAILINGNAME and the address on ADDRESS.LIST, both
 * built in `buildGstIdentity`, and neither needs a builder of its own.
 *
 * `BASICBUYERADDRESS` is deliberately not emitted: zero of 413 carry it.
 *
 * ── What the read-back first appeared to say, and did not ─────────────────
 * Two test pushes came back with the mailing name EMPTY, which read as Tally
 * refusing the field — and nearly bought a second, invented shape to work
 * around a refusal that never happened. Tally stored it correctly every time:
 * four hand-written orderings of the same voucher all read back intact. The
 * harness was calling `pushVoucherToTally` without masters, which drops this
 * whole block before it is ever sent. Position within the voucher does not
 * matter; supplying the masters does.
 */
function addressFor(p: VoucherPayload, party: { address: string[] }): string[] {
  const typed = (p.buyerAddress ?? []).map((l) => l.trim()).filter(Boolean);
  return typed.length ? typed : party.address;
}


function buildLedgerEntries(entries: LedgerEntry[], isInvoice: boolean, voucherDate: string): string {
  const tag = isInvoice ? "LEDGERENTRIES.LIST" : "ALLLEDGERENTRIES.LIST";
  return entries.map(e => {
    const amt = e.signedAmount !== undefined ? e.signedAmount.toFixed(2) : tallyAmount(e.amount, e.isDeemedPositive);
    /**
     * The four tags that make a line reduce (or add to) assessable value rather
     * than sit beside it as an expense, copied from what Tally itself writes on
     * this company's discounted invoices. `VATEXPAMOUNT` mirrors `AMOUNT` — it
     * is the figure GST is appropriated over.
     */
    const gstAppropriation = e.appropriateToGst ? `
    <APPROPRIATEFOR>GST</APPROPRIATEFOR>
    <GSTAPPROPRIATETO>${esc(e.appropriateToGst)}</GSTAPPROPRIATETO>
    <EXCISEALLOCTYPE>Based on Value</EXCISEALLOCTYPE>
    <METHODTYPE>As User Defined Value</METHODTYPE>
    <VATEXPAMOUNT>${amt}</VATEXPAMOUNT>` : "";
    return `
  <${tag}>
    <LEDGERNAME>${esc(e.ledgerName)}</LEDGERNAME>
    <ISDEEMEDPOSITIVE>${e.isDeemedPositive ? "Yes" : "No"}</ISDEEMEDPOSITIVE>
    <ISPARTYLEDGER>${e.isPartyLedger ? "Yes" : "No"}</ISPARTYLEDGER>${gstAppropriation}
    <AMOUNT>${amt}</AMOUNT>
    ${e.billAllocations && e.billAllocations.length > 0 ? buildBillAllocations(e.billAllocations, e.isDeemedPositive) : ""}
    ${e.bankAllocation ? buildBankAllocation(e.bankAllocation, e.amount, e.isDeemedPositive, voucherDate) : ""}
  </${tag}>`;
  }).join("");
}

function buildInventoryEntries(entries: InventoryEntry[]): string {
  return entries.map(e => `
  <ALLINVENTORYENTRIES.LIST>
    <STOCKITEMNAME>${esc(e.stockItemName)}</STOCKITEMNAME>
    <ISDEEMEDPOSITIVE>${e.isDeemedPositive ? "Yes" : "No"}</ISDEEMEDPOSITIVE>
    <ACTUALQTY>${e.quantity} ${esc(e.unit)}</ACTUALQTY>
    <BILLEDQTY>${e.quantity} ${esc(e.unit)}</BILLEDQTY>
    <RATE>${e.rate.toFixed(2)}/${esc(e.unit)}</RATE>
    <AMOUNT>${tallyAmount(e.amount, e.isDeemedPositive)}</AMOUNT>
    ${e.godownName ? `
    <BATCHALLOCATIONS.LIST>
      <GODOWNNAME>${esc(e.godownName)}</GODOWNNAME>
      <BATCHNAME>${esc(e.batchName || "Primary Batch")}</BATCHNAME>
      <AMOUNT>${tallyAmount(e.amount, e.isDeemedPositive)}</AMOUNT>
      <ACTUALQTY>${e.quantity} ${esc(e.unit)}</ACTUALQTY>
      <BILLEDQTY>${e.quantity} ${esc(e.unit)}</BILLEDQTY>
    </BATCHALLOCATIONS.LIST>` : ""}
    ${e.salesLedgerName ? `
    <ACCOUNTINGALLOCATIONS.LIST>
      <LEDGERNAME>${esc(e.salesLedgerName)}</LEDGERNAME>
      <ISDEEMEDPOSITIVE>${e.isDeemedPositive ? "Yes" : "No"}</ISDEEMEDPOSITIVE>
      <AMOUNT>${tallyAmount(e.amount, e.isDeemedPositive)}</AMOUNT>
    </ACCOUNTINGALLOCATIONS.LIST>` : ""}
  </ALLINVENTORYENTRIES.LIST>`).join("");
}

/**
 * Build Tally Import Data XML for a single voucher.
 * For accounting vouchers (Sales/Purchase/Journal etc.), validates Dr/Cr balance.
 * For inventory vouchers (Delivery Note/Receipt Note), skips balance check.
 */
/**
 * `masters` is optional only so the XML-dumping scripts can call this without a
 * live Tally. Production always passes it: without the masters the voucher
 * carries no party GST identity and lands in the GSTR-1 exception bucket.
 */
export function buildVoucherImportXml(company: string, payload: VoucherPayload, masters?: TallyMasters): string {
  const isInventoryVoucher = isInventoryVoucherType(payload.voucherType);

  // Validate Dr/Cr balance only for accounting vouchers.
  //
  // In INVOICE mode the sales/purchase ledger must NOT appear as its own
  // ledger entry — it belongs inside each inventory line's
  // ACCOUNTINGALLOCATIONS. Listing it in both places double-counts that side,
  // and Tally rejects the whole voucher with EXCEPTIONS=1 and no error text.
  // So here the inventory lines supply the contra side, and the balance is
  // ledger entries (party + taxes) against the inventory total.
  if (!isInventoryVoucher && payload.ledgerEntries.length > 0) {
    // Balance against the values Tally will actually see. A line carrying an
    // explicit signedAmount (a negative credit, e.g. TRADE DISCOUNTS) emits that
    // value verbatim, so deriving its sign again here would check a different
    // voucher than the one being sent.
    const ledgerSide = payload.ledgerEntries.reduce(
      (sum, e) => sum + (e.signedAmount !== undefined
        ? e.signedAmount
        : (e.isDeemedPositive ? -Math.abs(e.amount) : Math.abs(e.amount))), 0);
    const inventorySide = (isInvoiceShaped(payload) ? payload.inventoryEntries ?? [] : []).reduce(
      (sum, e) => sum + (e.isDeemedPositive ? -Math.abs(e.amount) : Math.abs(e.amount)), 0);
    const balance = ledgerSide + inventorySide;
    if (Math.abs(balance) > 0.02) {
      throw new Error(
        `Dr/Cr imbalance: ${balance.toFixed(2)}. Ledger entries ${ledgerSide.toFixed(2)} + ` +
        `inventory ${inventorySide.toFixed(2)} must sum to zero.` +
        (isInvoiceShaped(payload) ? " In invoice mode the sales/purchase ledger belongs only in the inventory line's accounting allocation, not as its own ledger entry." : "")
      );
    }
  }

  const date = toVoucherDate(payload.date);
  const hasInventory = payload.inventoryEntries && payload.inventoryEntries.length > 0;
  const objView = getObjView(payload.voucherType, isInvoiceShaped(payload), !!hasInventory);

  return `<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Vouchers</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY>
        </STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <VOUCHER${payload.remoteId ? ` REMOTEID="${esc(payload.remoteId)}"` : ""} VCHTYPE="${esc(payload.voucherType)}" ACTION="${esc(payload.action ?? "Create")}" OBJVIEW="${esc(objView)}">
            <DATE>${date}</DATE>${
              /* Tally fills every other party identity field from the ledger
                 master on import; the address is the one it expects from us.
                 Emitted before VOUCHERTYPENAME to match the shape Tally's own
                 export writes. Empty lines are dropped rather than sent as
                 blank ADDRESS elements. */
              (payload.partyAddress ?? []).filter((l) => l && l.trim()).length
                ? `
            <ADDRESS.LIST TYPE="String">${(payload.partyAddress ?? [])
                    .filter((l) => l && l.trim())
                    .map((l) => `<ADDRESS>${esc(l.trim())}</ADDRESS>`).join("")}</ADDRESS.LIST>`
                : ""
            }
            <VOUCHERTYPENAME>${esc(payload.voucherType)}</VOUCHERTYPENAME>
            <ISINVOICE>${payload.isInvoice ? "Yes" : "No"}</ISINVOICE>
            ${/RECEIPT NOTE/.test(payload.voucherType.toUpperCase()) ? "" : `<PERSISTEDVIEW>${esc(objView)}</PERSISTEDVIEW>`}
            ${payload.voucherNumber ? `<VOUCHERNUMBER>${esc(payload.voucherNumber)}</VOUCHERNUMBER>` : ""}
            ${payload.reference ? `<REFERENCE>${esc(payload.reference)}</REFERENCE>` : ""}
            ${payload.referenceDate ? `<REFERENCEDATE>${esc(toVoucherDate(payload.referenceDate))}</REFERENCEDATE>` : ""}
            ${payload.narration ? `<NARRATION>${esc(payload.narration)}</NARRATION>` : ""}
            <PARTYLEDGERNAME>${esc(payload.partyLedgerName)}</PARTYLEDGERNAME>
            ${buildGstIdentity(payload, masters)}
            ${isInvoiceShaped(payload) ? `<PARTYNAME>${esc(payload.partyLedgerName)}</PARTYNAME>
            <BASICBASEPARTYNAME>${esc(payload.partyLedgerName)}</BASICBASEPARTYNAME>
            <VCHENTRYMODE>${hasInventory ? "Item Invoice" : "Accounting Invoice"}</VCHENTRYMODE>` : ""}
            ${buildLedgerEntries(payload.ledgerEntries, isInvoiceShaped(payload), payload.date)}
            ${hasInventory ? buildInventoryEntries(payload.inventoryEntries!) : ""}
          </VOUCHER>
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;
}

/**
 * Parse Tally's Import Data response.
 * Tally returns: ENVELOPE.BODY.DATA.IMPORTRESULT.{CREATED, ERRORS, LASTVCHID}
 * Plus optional LINEERROR elements for field-level errors.
 */
export function parseImportResponse(rawXml: string): PushResult {
  const lineErrors: string[] = [];

  // Always extract LINEERROR via regex — most reliable method
  const lineErrMatches = [...rawXml.matchAll(/<LINEERROR>([^<]*)<\/LINEERROR>/g)];
  for (const m of lineErrMatches) {
    if (m[1]?.trim()) lineErrors.push(m[1].trim());
  }

  let created = 0;
  let altered = 0;
  let deleted = 0;
  let exceptions = 0;
  let errCount = lineErrors.length;
  let lastVchId: string | null = null;

  try {
    const parsed = parser.parse(rawXml);

    // TallyPrime ERP 9 puts results in IMPORTRESULT
    const importResult =
      parsed?.ENVELOPE?.BODY?.DATA?.IMPORTRESULT ??
      parsed?.ENVELOPE?.BODY?.IMPORTRESULT ??
      null;

    if (importResult) {
      created  = parseInt(String(importResult.CREATED  ?? "0"), 10) || 0;
      // ALTERED covers both an Alter and a Cancel: Tally reports a cancel as an
      // alteration, never under a count of its own.
      altered  = parseInt(String(importResult.ALTERED  ?? "0"), 10) || 0;
      deleted  = parseInt(String(importResult.DELETED  ?? "0"), 10) || 0;
      // EXCEPTIONS is the signal that means "Tally accepted the request and
      // refused the CONTENT, and will not say why". It was not read at all —
      // so a voucher rejected this way reported success=true with errors=0.
      exceptions = parseInt(String(importResult.EXCEPTIONS ?? "0"), 10) || 0;
      errCount = parseInt(String(importResult.ERRORS   ?? "0"), 10);
      lastVchId = importResult.LASTVCHID ? String(importResult.LASTVCHID) : null;
    } else {
      // Fallback: regex scan — handles any Tally version quirks
      const createdMatch = rawXml.match(/<CREATED>(\d+)<\/CREATED>/);
      if (createdMatch) created = parseInt(createdMatch[1], 10) || 0;
      const alteredMatch = rawXml.match(/<ALTERED>(\d+)<\/ALTERED>/);
      if (alteredMatch) altered = parseInt(alteredMatch[1], 10) || 0;
      const deletedMatch = rawXml.match(/<DELETED>(\d+)<\/DELETED>/);
      if (deletedMatch) deleted = parseInt(deletedMatch[1], 10) || 0;
      const excMatch = rawXml.match(/<EXCEPTIONS>(\d+)<\/EXCEPTIONS>/);
      if (excMatch) exceptions = parseInt(excMatch[1], 10) || 0;
      const errorsMatch = rawXml.match(/<ERRORS>(\d+)<\/ERRORS>/);
      if (errorsMatch) errCount = parseInt(errorsMatch[1], 10);
      const lastVchMatch = rawXml.match(/<LASTVCHID>([^<]+)<\/LASTVCHID>/);
      if (lastVchMatch) lastVchId = lastVchMatch[1].trim();
    }

    // Ensure errCount accounts for any LINEERROR messages
    if (lineErrors.length > 0 && errCount === 0) errCount = lineErrors.length;

    return {
      // Tally DID something. An Alter reports ALTERED=1 CREATED=0 and a Delete
      // reports DELETED=1 CREATED=0 — reading only CREATED called both failures.
      // An EXCEPTION is a refusal even when Tally counted something. Omitting
      // it from this test is how a silently-wrong voucher reported success.
      success: (created > 0 || altered > 0 || deleted > 0)
        && errCount === 0 && lineErrors.length === 0 && exceptions === 0,
      created,
      altered,
      deleted,
      exceptions,
      errors: errCount,
      lastVoucherId: lastVchId,
      lineErrors,
      rawResponse: rawXml.slice(0, 2000),
    };
  } catch {
    return {
      success: false,
      created: 0,
      altered: 0,
      deleted: 0,
      exceptions: 0,
      errors: 1,
      lastVoucherId: null,
      lineErrors: lineErrors.length > 0 ? lineErrors : ["Failed to parse Tally response"],
      rawResponse: rawXml.slice(0, 2000),
    };
  }
}

/**
 * Push a single voucher to Tally.
 *
 * ⚠ `masters` is REQUIRED, and that is not a formality.
 *
 * `buildGstIdentity` opens with `if (!masters) return ""`, so calling this
 * without them builds a voucher carrying no PARTYMAILINGNAME, no ADDRESS.LIST,
 * no STATENAME, no PLACEOFSUPPLY and no GSTIN — and Tally accepts it with
 * `created=1` and no exception. Production has always passed them, through
 * `safePush`; the fidelity harness did not, and so spent a session verifying a
 * structurally weaker voucher than the one the app actually sends. The missing
 * block read back as a missing buyer name, which looked exactly like Tally
 * refusing the field.
 *
 * Nothing typechecks these call sites — `tsconfig.json` includes only `src` —
 * so the signature is the only guard there is. It throws rather than degrading.
 */
export async function pushVoucherToTally(
  tallyUrl: string,
  company: string,
  payload: VoucherPayload,
  masters: TallyMasters
): Promise<PushResult> {
  if (!masters) {
    throw new Error(
      "pushVoucherToTally requires masters — without them the voucher is built " +
      "with no GST identity block and Tally accepts it silently. See the note above.",
    );
  }
  const xml = buildVoucherImportXml(company, payload, masters);
  const rawResponse = await tallyPost(tallyUrl, xml, 30_000, true);
  const responseText = typeof rawResponse === "string" ? rawResponse : JSON.stringify(rawResponse);
  return parseImportResponse(responseText);
}
