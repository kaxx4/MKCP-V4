import type { VoucherPayload, LedgerEntry, InventoryEntry, BillAllocation, PushResult } from "../types.js";
import { tallyPost } from "../tally.js";
import { XMLParser } from "fast-xml-parser";

const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: true });

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** YYYY-MM-DD → YYYYMMDD */
function toVoucherDate(date: string): string {
  return date.replace(/-/g, "");
}

/** Format amount for Tally: positive Credit, negative Debit */
function tallyAmount(amount: number, isDeemedPositive: boolean): string {
  // isDeemedPositive = true means Debit → negative in Tally convention
  const signed = isDeemedPositive ? -Math.abs(amount) : Math.abs(amount);
  return signed.toFixed(2);
}

function buildBillAllocations(allocs: BillAllocation[]): string {
  return allocs.map(b => `
    <BILLALLOCATIONS.LIST>
      <NAME>${esc(b.name)}</NAME>
      <BILLTYPE>${esc(b.billType)}</BILLTYPE>
      <AMOUNT>${tallyAmount(b.amount, true)}</AMOUNT>
    </BILLALLOCATIONS.LIST>`).join("");
}

function buildLedgerEntries(entries: LedgerEntry[]): string {
  return entries.map(e => `
  <ALLLEDGERENTRIES.LIST>
    <LEDGERNAME>${esc(e.ledgerName)}</LEDGERNAME>
    <ISDEEMEDPOSITIVE>${e.isDeemedPositive ? "Yes" : "No"}</ISDEEMEDPOSITIVE>
    <ISPARTYLEDGER>${e.isPartyLedger ? "Yes" : "No"}</ISPARTYLEDGER>
    <AMOUNT>${tallyAmount(e.amount, e.isDeemedPositive)}</AMOUNT>
    ${e.billAllocations && e.billAllocations.length > 0 ? buildBillAllocations(e.billAllocations) : ""}
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
    <ACCOUNTINGALLOCATIONS.LIST>
      <LEDGERNAME>${esc(e.salesLedgerName)}</LEDGERNAME>
      <ISDEEMEDPOSITIVE>${e.isDeemedPositive ? "Yes" : "No"}</ISDEEMEDPOSITIVE>
      <AMOUNT>${e.amount.toFixed(2)}</AMOUNT>
    </ACCOUNTINGALLOCATIONS.LIST>
  </ALLINVENTORYENTRIES.LIST>`).join("");
}

/**
 * Build Tally Import Data XML for a single voucher.
 * Validates Dr/Cr balance before building.
 */
export function buildVoucherImportXml(company: string, payload: VoucherPayload): string {
  // Validate Dr/Cr balance
  const balance = payload.ledgerEntries.reduce((sum, e) => {
    return sum + (e.isDeemedPositive ? -e.amount : e.amount);
  }, 0);
  if (Math.abs(balance) > 0.02) {
    throw new Error(`Dr/Cr imbalance: ${balance.toFixed(2)}. Sum of all ledger entries must be zero.`);
  }

  const date = toVoucherDate(payload.date);
  const hasInventory = payload.inventoryEntries && payload.inventoryEntries.length > 0;
  const objView = payload.isInvoice && hasInventory ? "Invoice Voucher View" : "Accounting Voucher View";

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

/** Parse Tally's Import Data response */
export function parseImportResponse(rawXml: string): PushResult {
  const lineErrors: string[] = [];

  // Extract LINEERROR tags
  const lineErrMatches = [...rawXml.matchAll(/<LINEERROR>([^<]*)<\/LINEERROR>/g)];
  for (const m of lineErrMatches) {
    if (m[1]?.trim()) lineErrors.push(m[1].trim());
  }

  try {
    const parsed = parser.parse(rawXml);
    const resp = parsed?.ENVELOPE?.BODY?.DATA?.LINEERROR ??
                 parsed?.RESPONSE ??
                 parsed?.ENVELOPE?.RESPONSE ??
                 null;

    // Try to find CREATED, ERRORS, LASTVCHID in the response
    const created = parseInt(resp?.CREATED ?? "0", 10) || 0;
    const errors = parseInt(resp?.ERRORS ?? "0", 10) || lineErrors.length;
    const lastVchId = resp?.LASTVCHID ?? null;

    return {
      success: created > 0 && errors === 0,
      created,
      errors,
      lastVoucherId: lastVchId ? String(lastVchId) : null,
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

/** Push multiple vouchers to Tally — returns per-voucher results */
export async function pushBatchToTally(
  tallyUrl: string,
  company: string,
  payloads: VoucherPayload[]
): Promise<{ results: PushResult[]; successCount: number; errorCount: number }> {
  const results: PushResult[] = [];
  for (const payload of payloads) {
    try {
      const result = await pushVoucherToTally(tallyUrl, company, payload);
      results.push(result);
    } catch (e: any) {
      results.push({
        success: false,
        created: 0,
        errors: 1,
        lastVoucherId: null,
        lineErrors: [e.message],
        rawResponse: "",
      });
    }
  }
  const successCount = results.filter(r => r.success).length;
  const errorCount = results.length - successCount;
  return { results, successCount, errorCount };
}
