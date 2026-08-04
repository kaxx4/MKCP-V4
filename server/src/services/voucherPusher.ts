import type { VoucherPayload, LedgerEntry, InventoryEntry, BillAllocation, PushResult } from "../types.js";
import { tallyPost } from "../tally.js";
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

function buildLedgerEntries(entries: LedgerEntry[]): string {
  return entries.map(e => `
  <ALLLEDGERENTRIES.LIST>
    <LEDGERNAME>${esc(e.ledgerName)}</LEDGERNAME>
    <ISDEEMEDPOSITIVE>${e.isDeemedPositive ? "Yes" : "No"}</ISDEEMEDPOSITIVE>
    <ISPARTYLEDGER>${e.isPartyLedger ? "Yes" : "No"}</ISPARTYLEDGER>
    <AMOUNT>${tallyAmount(e.amount, e.isDeemedPositive)}</AMOUNT>
    ${e.billAllocations && e.billAllocations.length > 0 ? buildBillAllocations(e.billAllocations, e.isDeemedPositive) : ""}
  </ALLLEDGERENTRIES.LIST>`).join("");
}

function buildInventoryEntries(entries: InventoryEntry[]): string {
  return entries.map(e => `
  <ALLINVENTORYENTRIES.LIST>
    <STOCKITEMNAME>${esc(e.stockItemName)}</STOCKITEMNAME>
    <ISDEEMEDPOSITIVE>${e.isDeemedPositive ? "Yes" : "No"}</ISDEEMEDPOSITIVE>
    <ACTUALQTY>${e.quantity} ${esc(e.unit)}</ACTUALQTY>
    <BILLEDQTY>${e.quantity} ${esc(e.unit)}</BILLEDQTY>
    <RATE>${e.rate.toFixed(2)}/${esc(e.unit)}</RATE>
    <AMOUNT>${e.amount.toFixed(2)}</AMOUNT>
    ${e.salesLedgerName ? `
    <ACCOUNTINGALLOCATIONS.LIST>
      <LEDGERNAME>${esc(e.salesLedgerName)}</LEDGERNAME>
      <ISDEEMEDPOSITIVE>${e.isDeemedPositive ? "Yes" : "No"}</ISDEEMEDPOSITIVE>
      <AMOUNT>${e.amount.toFixed(2)}</AMOUNT>
    </ACCOUNTINGALLOCATIONS.LIST>` : ""}
  </ALLINVENTORYENTRIES.LIST>`).join("");
}

/**
 * Build Tally Import Data XML for a single voucher.
 * For accounting vouchers (Sales/Purchase/Journal etc.), validates Dr/Cr balance.
 * For inventory vouchers (Delivery Note/Receipt Note), skips balance check.
 */
export function buildVoucherImportXml(company: string, payload: VoucherPayload): string {
  const isInventoryVoucher = isInventoryVoucherType(payload.voucherType);

  // Validate Dr/Cr balance only for accounting vouchers
  if (!isInventoryVoucher && payload.ledgerEntries.length > 0) {
    const balance = payload.ledgerEntries.reduce((sum, e) => {
      return sum + (e.isDeemedPositive ? -e.amount : e.amount);
    }, 0);
    if (Math.abs(balance) > 0.02) {
      throw new Error(`Dr/Cr imbalance: ${balance.toFixed(2)}. Sum of all ledger entries must be zero.`);
    }
  }

  const date = toVoucherDate(payload.date);
  const hasInventory = payload.inventoryEntries && payload.inventoryEntries.length > 0;
  const objView = getObjView(payload.voucherType, payload.isInvoice, !!hasInventory);

  return `<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Voucher Register</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY>
        </STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <VOUCHER VCHTYPE="${esc(payload.voucherType)}" ACTION="Create" OBJVIEW="${esc(objView)}">
            <DATE>${date}</DATE>
            <VOUCHERTYPENAME>${esc(payload.voucherType)}</VOUCHERTYPENAME>
            <ISINVOICE>${payload.isInvoice ? "Yes" : "No"}</ISINVOICE>
            <PERSISTEDVIEW>${esc(objView)}</PERSISTEDVIEW>
            ${payload.voucherNumber ? `<VOUCHERNUMBER>${esc(payload.voucherNumber)}</VOUCHERNUMBER>` : ""}
            ${payload.reference ? `<REFERENCE>${esc(payload.reference)}</REFERENCE>` : ""}
            ${payload.narration ? `<NARRATION>${esc(payload.narration)}</NARRATION>` : ""}
            <PARTYLEDGERNAME>${esc(payload.partyLedgerName)}</PARTYLEDGERNAME>
            ${buildLedgerEntries(payload.ledgerEntries)}
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
      errCount = parseInt(String(importResult.ERRORS   ?? "0"), 10);
      lastVchId = importResult.LASTVCHID ? String(importResult.LASTVCHID) : null;
    } else {
      // Fallback: regex scan — handles any Tally version quirks
      const createdMatch = rawXml.match(/<CREATED>(\d+)<\/CREATED>/);
      if (createdMatch) created = parseInt(createdMatch[1], 10) || 0;
      const errorsMatch = rawXml.match(/<ERRORS>(\d+)<\/ERRORS>/);
      if (errorsMatch) errCount = parseInt(errorsMatch[1], 10);
      const lastVchMatch = rawXml.match(/<LASTVCHID>([^<]+)<\/LASTVCHID>/);
      if (lastVchMatch) lastVchId = lastVchMatch[1].trim();
    }

    // Ensure errCount accounts for any LINEERROR messages
    if (lineErrors.length > 0 && errCount === 0) errCount = lineErrors.length;

    return {
      success: created > 0 && errCount === 0 && lineErrors.length === 0,
      created,
      errors: errCount,
      lastVoucherId: lastVchId,
      lineErrors,
      rawResponse: rawXml.slice(0, 2000),
    };
  } catch {
    return {
      success: false,
      created: 0,
      errors: 1,
      lastVoucherId: null,
      lineErrors: lineErrors.length > 0 ? lineErrors : ["Failed to parse Tally response"],
      rawResponse: rawXml.slice(0, 2000),
    };
  }
}

/** Push a single voucher to Tally */
export async function pushVoucherToTally(
  tallyUrl: string,
  company: string,
  payload: VoucherPayload
): Promise<PushResult> {
  const xml = buildVoucherImportXml(company, payload);
  const rawResponse = await tallyPost(tallyUrl, xml, 30_000, true);
  const responseText = typeof rawResponse === "string" ? rawResponse : JSON.stringify(rawResponse);
  return parseImportResponse(responseText);
}
