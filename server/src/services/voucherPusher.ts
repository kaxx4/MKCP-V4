import type { VoucherPayload, LedgerEntry, InventoryEntry, BillAllocation, PushResult } from "../types.js";
import { tallyPost } from "../tally.js";
import { findLedger, gstRateFor, hsnFor, mailingOn, registrationOn, type TallyMasters } from "./tallyMasters.js";
import { HOME_STATE_NAME, isInwardSupply, resolvePartyState } from "./pushGuard.js";
import { isCashLikeParty } from "./gstIdentity.js";
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
 * Everything the voucher says about WHO it is for — bill-to (Buyer) and ship-to
 * (Consignee) — as one value, so the builder and the read-back check in
 * `safePush` cannot disagree about what was meant.
 *
 * ── Why this is a struct and not a string of tags ────────────────────────
 * The owner, 23-Sep-2026: "You are adding the bill-to address but not the
 * ship-to … when pushing a cash invoice the ship-to address is empty; when
 * pushing a normal ledger invoice as well the ship-to is empty, and that's
 * giving an error in the e-way bill." And: "the GST and party details in the
 * e-way bill and e-invoice cannot be broken at any point."
 *
 * Read back off a pushed invoice the same day (scripts/test-push-fidelity-
 * sandbox.ts, S3 before the fix): BASICBUYERNAME, BASICBUYERADDRESS.LIST and
 * CONSIGNEECOUNTRYNAME were all EMPTY. The comment on `VoucherPayload.
 * partyAddress` claimed Tally fills BASICBUYERNAME from the ledger on import; it
 * does not. Every hand-typed invoice carries all three, with the ship-to
 * address identical to the bill-to (RANI CYCLE STORES 26-27/0658, DIBYASAKTI
 * 26-27/0551, KAMALABHA order 360/QUOTE-26-27). So they are emitted here,
 * always, from the same values as the bill-to block.
 *
 * ── Where each value comes from ──────────────────────────────────────────
 *   a real party ledger → its master, dated to the voucher (registrationOn,
 *                          mailingOn). A typed name or address on the payload
 *                          is IGNORED — the web app's party address is a
 *                          historical copy (src/data/partyAddresses.json), and
 *                          on 23-Sep a test proved it reached Tally as a SECOND
 *                          ADDRESS.LIST that Tally concatenated onto the real
 *                          one, printing the copy on the invoice.
 *   the shared Cash ledger → the walk-in the operator typed (buyerName,
 *                          buyerAddress), home state, Unregistered/Consumer —
 *                          on BOTH bill-to and ship-to.
 *
 * Money vouchers carry NO identity (Tally's own Payments, Contras and Journals
 * carry a GSTIN 0% of the time) and return null.
 */
export interface PartyIdentity {
  registrationType: string;
  vatDealerType: string;
  gstin: string;
  /** Destination of the goods — see the note in `partyIdentity`. */
  placeOfSupply: string;
  /** The counterparty's state. */
  state: string;
  country: string;
  mailingName: string;
  address: string[];
  pincode: string;
  /** BASICBUYERNAME — the consignee LEDGER, which is the party ledger itself. */
  consigneeLedger: string;
  /** Ship-to. Always equal to the bill-to fields above for this company. */
  consignee: { mailingName: string; address: string[]; pincode: string; state: string; country: string; gstin: string };
}

/** Tally's own words. "Unregistered" alone is not one of them for a sale — every
 *  hand-typed unregistered sale stores "Unregistered/Consumer" (463 of 465 in
 *  the FY26-27 books; the two exceptions are pushed ones). Two ledgers carry a
 *  dated registration of "\x04 Unknown", which must never be sent verbatim. */
export function normaliseRegistrationType(raw: string, registered: boolean): string {
  const v = raw.replace(/[\x00-\x1f]/g, "").trim();
  if (!v || /unknown|not applicable/i.test(v)) return registered ? "Regular" : "Unregistered/Consumer";
  if (/^unregistered$/i.test(v)) return "Unregistered/Consumer";
  return v;
}

/** A six-digit Indian PIN typed into a walk-in's address, if there is one. */
export function pincodeIn(lines: string[]): string {
  for (const l of lines) { const m = /(?:^|\D)([1-9]\d{5})(?!\d)/.exec(l); if (m) return m[1]; }
  return "";
}

export function partyIdentity(p: VoucherPayload, masters?: TallyMasters): PartyIdentity | null {
  if (!masters) return null;
  if (!isInvoiceShaped(p)) return null;
  const party = findLedger(masters, p.partyLedgerName);
  // A name the masters don't know is the guard's problem — it rejects the
  // voucher before the build. Emit nothing rather than guess.
  if (!party || "miss" in party) return null;

  // The registration and mailing details in force on THIS voucher's date — 61%
  // of vouchers here are backdated.
  const reg = registrationOn(party, p.date);
  const mail = mailingOn(party, p.date);
  const gstin = reg.gstin.trim();
  const registered = gstin.length > 0;

  // The counterparty's state; the payload may stand in only where the ledger has
  // none (the shared Cash ledger). The guard read the same resolver.
  const state = resolvePartyState(p, (reg.placeOfSupply || reg.state || mail.state).trim()).state;

  /* Place of supply is the DESTINATION of the goods: outward → the party's
     state; inward (Purchase, Debit Note, Receipt Note) → OUR state. A native
     purchase from a Delhi supplier stores PLACEOFSUPPLY West Bengal with
     STATENAME Delhi. */
  const placeOfSupply = isInwardSupply(p.voucherType) ? HOME_STATE_NAME : state;

  /* A walk-in is a ledger with no identity of its own: no GSTIN, no address, no
     state. Only then do the operator's typed name and address apply.
     `MIXED ORDER` is the exception that PROVES this can't be state-derived
     alone: its ledger carries a state (West Bengal, unlike Cash) but is not a
     real, single, addressable buyer — several cash orders billed together,
     a different buyer every time (owner, 24-Sep-2026). So it is forced onto
     the walk-in path by name (`isCashLikeParty`) even though the state test
     alone would say otherwise. */
  const walkIn = isCashLikeParty(party.name) || (!registered && !mail.address.length && !(party.state || "").trim());
  const typed = (p.buyerAddress ?? []).map((l) => l.trim()).filter(Boolean);
  const address = walkIn ? typed : mail.address;
  const mailingName = (walkIn ? p.buyerName?.trim() : "") || (mail.mailingName ?? "").trim() || party.name;
  const pincode = (mail.pincode ?? "").trim() || (walkIn ? pincodeIn(typed) : "");
  const country = (mail.country || "India").trim();

  const registrationType = normaliseRegistrationType(reg.registrationType, registered);
  return {
    registrationType,
    vatDealerType: registered ? (/composition/i.test(registrationType) ? "Composition" : "Regular") : "Unregistered",
    gstin, placeOfSupply, state, country, mailingName, address, pincode,
    consigneeLedger: party.name,
    // Bill-to and ship-to are always the same party here (owner, 23-Sep-2026).
    consignee: { mailingName, address, pincode, state, country, gstin },
  };
}

function renderIdentity(id: PartyIdentity): string {
  const tag = (t: string, v: string) => (v ? `\n            <${t}>${esc(v)}</${t}>` : "");
  const list = (t: string, ls: string[]) =>
    ls.length ? `\n            <${t}.LIST TYPE="String">${ls.map((a) => `<${t}>${esc(a)}</${t}>`).join("")}</${t}.LIST>` : "";
  return [
    // ── Buyer (bill to) ──
    list("ADDRESS", id.address),
    tag("GSTREGISTRATIONTYPE", id.registrationType),
    tag("VATDEALERTYPE", id.vatDealerType),
    tag("PARTYGSTIN", id.gstin),
    tag("PLACEOFSUPPLY", id.placeOfSupply),
    tag("STATENAME", id.state),
    tag("COUNTRYOFRESIDENCE", id.country),
    tag("PARTYMAILINGNAME", id.mailingName),
    tag("PARTYPINCODE", id.pincode),
    // ── Consignee (ship to) — what the e-way bill reads ──
    tag("BASICBUYERNAME", id.consigneeLedger),
    list("BASICBUYERADDRESS", id.consignee.address),
    tag("CONSIGNEEGSTIN", id.consignee.gstin),
    tag("CONSIGNEEMAILINGNAME", id.consignee.mailingName),
    tag("CONSIGNEEPINCODE", id.consignee.pincode),
    tag("CONSIGNEESTATENAME", id.consignee.state),
    tag("CONSIGNEECOUNTRYNAME", id.consignee.country),
  ].join("");
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

/**
 * Where a stock line's GST rate and HSN come from, AND the resolved values —
 * the shape Tally itself stores on a line typed into an invoice.
 *
 * Without the source tags Tally cannot tie the line to any rate, and GST Tax
 * Analysis files it under "Tax rate/tax type not specified" (cash split
 * invoices 26-27/0718..0723, 23-Sep-2026). The source tags alone were not the
 * whole shape: read back the same day, a pushed line carried GSTSOURCETYPE but
 * an EMPTY GSTHSNNAME and no RATEDETAILS, while every hand-typed line
 * (26-27/0654) stores the HSN, its description and one RATEDETAILS block per
 * duty head. Tally does not compute these on an XML import — it stores what it
 * is given — so they are sent, from the same master chain Tally resolves.
 *
 * The HSN is resolved along its own chain (`hsnFor`): an item may declare its
 * own rate and still inherit its HSN from its group.
 *
 * Returns empty strings when the masters are absent or nothing in the chain
 * declares a rate — the line then goes out exactly as before.
 */
function buildLineGst(itemName: string, masters: TallyMasters | undefined, asOf: string | undefined): { head: string; rates: string } {
  const none = { head: "", rates: "" };
  if (!masters) return none;
  const item = masters.items.get(itemName);
  if (!item) return none;
  const r = gstRateFor(masters, itemName, asOf);
  if (!(r.rate > 0)) return none;
  let gstSrc: string;
  if (r.source === "item") {
    gstSrc = `
    <GSTSOURCETYPE>Stock Item</GSTSOURCETYPE>
    <GSTITEMSOURCE>${esc(item.name)}</GSTITEMSOURCE>`;
  } else {
    const group = /^stock group "(.*)"$/.exec(r.source)?.[1];
    if (!group) return none;
    gstSrc = `
    <GSTSOURCETYPE>Stock Group</GSTSOURCETYPE>
    <GSTSTOCKGROUPSOURCE>${esc(group)}</GSTSTOCKGROUPSOURCE>`;
  }
  const h = hsnFor(masters, itemName, asOf);
  const hsnGroup = /^stock group "(.*)"$/.exec(h.source)?.[1];
  // No declared HSN anywhere: fall back to naming the rate's source, as before.
  const hsnSrc = h.source === "item"
    ? `
    <HSNSOURCETYPE>Stock Item</HSNSOURCETYPE>
    <HSNITEMSOURCE>${esc(item.name)}</HSNITEMSOURCE>`
    : hsnGroup
      ? `
    <HSNSOURCETYPE>Stock Group</HSNSOURCETYPE>
    <HSNSTOCKGROUPSOURCE>${esc(hsnGroup)}</HSNSTOCKGROUPSOURCE>`
      : gstSrc.replace(/<GSTSOURCETYPE>/g, "<HSNSOURCETYPE>").replace(/<\/GSTSOURCETYPE>/g, "</HSNSOURCETYPE>")
          .replace(/GSTITEMSOURCE/g, "HSNITEMSOURCE").replace(/GSTSTOCKGROUPSOURCE/g, "HSNSTOCKGROUPSOURCE");

  const rev = r.revision;
  const igst = rev?.igst || r.rate;
  const cgst = rev?.cgst || igst / 2;
  const sgst = rev?.sgst || cgst;
  const num = (n: number) => String(Math.round(n * 1000) / 1000);
  /* All five heads, exactly as a typed line stores them — including Cess with
     Tally's own "&#4; Not Applicable" valuation type. Every hand-typed line
     carries the Cess head; GSTR-1's one-off "Cess Valuation Type is invalid or
     not specified" (tally-gst-identity-required, "still unexplained") is the
     exception a line WITHOUT it would raise. */
  const head = (duty: string, rate: number, valuation = "Based on Value") => `
    <RATEDETAILS.LIST>
      <GSTRATEDUTYHEAD>${duty}</GSTRATEDUTYHEAD>
      <GSTRATEVALUATIONTYPE>${valuation}</GSTRATEVALUATIONTYPE>
      <GSTRATE>${num(rate)}</GSTRATE>
    </RATEDETAILS.LIST>`;

  return {
    head: `
    <GSTOVRDNTAXABILITY>Taxable</GSTOVRDNTAXABILITY>${gstSrc}${hsnSrc}
    <GSTOVRDNTYPEOFSUPPLY>Goods</GSTOVRDNTYPEOFSUPPLY>
    <GSTRATEINFERAPPLICABILITY>As per Masters/Company</GSTRATEINFERAPPLICABILITY>${h.code ? `
    <GSTHSNNAME>${esc(h.code)}</GSTHSNNAME>${h.description ? `
    <GSTHSNDESCRIPTION>${esc(h.description)}</GSTHSNDESCRIPTION>` : ""}` : ""}
    <GSTHSNINFERAPPLICABILITY>As per Masters/Company</GSTHSNINFERAPPLICABILITY>`,
    rates: head("CGST", cgst) + head("SGST/UTGST", sgst) + head("IGST", igst)
      + head("Cess", 0, "&#4; Not Applicable") + head("State Cess", 0),
  };
}

function buildInventoryEntries(entries: InventoryEntry[], masters?: TallyMasters, asOf?: string): string {
  return entries.map(e => { const gst = buildLineGst(e.stockItemName, masters, asOf); return `
  <ALLINVENTORYENTRIES.LIST>
    <STOCKITEMNAME>${esc(e.stockItemName)}</STOCKITEMNAME>${gst.head}
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
    </ACCOUNTINGALLOCATIONS.LIST>` : ""}${gst.rates}
  </ALLINVENTORYENTRIES.LIST>`; }).join("");
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
  const identity = partyIdentity(payload, masters);
  /* `partyAddress` is only a fallback for a build WITHOUT masters (the XML
     dump scripts). With masters the identity block carries the address from
     the ledger, and sending partyAddress as well put a second ADDRESS.LIST on
     the voucher, which Tally CONCATENATES — the typed copy printed above the
     real address (read back 23-Sep-2026). */
  const fallbackAddress = identity ? [] : (payload.partyAddress ?? []).filter((l) => l && l.trim());
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
              fallbackAddress.length
                ? `
            <ADDRESS.LIST TYPE="String">${fallbackAddress
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
            ${identity ? renderIdentity(identity) : ""}
            ${isInvoiceShaped(payload) ? `<PARTYNAME>${esc(payload.partyLedgerName)}</PARTYNAME>
            <BASICBASEPARTYNAME>${esc(payload.partyLedgerName)}</BASICBASEPARTYNAME>
            <VCHENTRYMODE>${hasInventory ? "Item Invoice" : "Accounting Invoice"}</VCHENTRYMODE>` : ""}
            ${buildLedgerEntries(payload.ledgerEntries, isInvoiceShaped(payload), payload.date)}
            ${hasInventory ? buildInventoryEntries(payload.inventoryEntries!, isInwardSupply(payload.voucherType) ? undefined : masters, payload.date) : ""}
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
 * `partyIdentity` returns null without masters, so calling this
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
