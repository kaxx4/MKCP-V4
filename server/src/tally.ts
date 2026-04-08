import * as http from "node:http";
import { URL } from "node:url";
import { XMLParser } from "fast-xml-parser";

// ─────────────────────────────────────────────────────────────────────
// XML Parser ───────────────────────────────────────────────────────────
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  parseTagValue: false,  // Keep everything as strings — parsers handle conversion
  trimValues: true,
  isArray: (tag) => {
    const t = tag.toUpperCase().replace(/\.LIST$/, "");
    return ARRAY_TAGS.has(t);
  },
});

const ARRAY_TAGS = new Set([
  "TALLYMESSAGE", "VOUCHER", "LEDGER", "STOCKITEM", "STOCKGROUP", "UNIT", "COMPANY", "GODOWN", "COSTCENTRE",
  "ALLLEDGERENTRIES", "LEDGERENTRIES", "ALLINVENTORYENTRIES", "INVENTORYENTRIES",
  "BILLALLOCATIONS", "BATCHALLOCATIONS", "ACCOUNTINGALLOCATIONS",
  "BANKALLOCATIONS", "COSTCENTREALLOCATIONS", "COSTALLOCATIONS",
  "GSTDETAILS", "HSNDETAILS", "STATEWISEDETAILS", "RATEDETAILS",
  "CATEGORYALLOCATIONS", "INVENTORYALLOCATIONS",
]);

/**
 * POST XML to Tally using node:http with SOCKET-LEVEL timeout.
 * Unlike fetch(), this properly handles Tally's slow response generation.
 *
 * @param tallyUrl  e.g. "http://localhost:9000"
 * @param xml       XML request body
 * @param timeoutMs Socket timeout (default 5 minutes)
 * @param rawMode   If true, return raw string instead of parsed object
 * @param signal    Optional AbortSignal to cancel the request externally
 */
export function tallyPost(tallyUrl: string, xml: string, timeoutMs = 300_000, rawMode = false, signal?: AbortSignal): Promise<any> {
  return new Promise((resolve, reject) => {
    const url = new URL(tallyUrl);
    const label = xml.match(/<ID[^>]*>([^<]+)/)?.[1] || "request";
    const t0 = Date.now();
    let settled = false;

    const reqBody = Buffer.from(xml, "utf-8");

    // Hard wall-clock deadline — prevents infinite hangs even if socket timeout doesn't fire
    const hardDeadline = setTimeout(() => {
      if (settled) return;
      settled = true;
      console.error(`[tally] ✗ ${label}: HARD DEADLINE after ${((Date.now() - t0) / 1000).toFixed(0)}s — destroying request`);
      req.destroy();
      reject(new Error(`Tally hard timeout: ${label} took longer than ${Math.round(timeoutMs / 1000)}s (wall-clock)`));
    }, timeoutMs + 5_000); // 5s grace beyond the socket timeout

    function settle(fn: () => void) {
      if (settled) return;
      settled = true;
      clearTimeout(hardDeadline);
      fn();
    }

    // Handle external abort (client disconnect)
    if (signal) {
      if (signal.aborted) {
        clearTimeout(hardDeadline);
        return reject(new Error(`Aborted: ${label}`));
      }
      signal.addEventListener("abort", () => {
        if (!settled) {
          settled = true;
          clearTimeout(hardDeadline);
          req.destroy();
          reject(new Error(`Aborted: ${label}`));
        }
      }, { once: true });
    }

    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || 9000,
        path: "/",
        method: "POST",
        headers: {
          "Content-Type": "text/xml; charset=utf-8",
          "Content-Length": reqBody.length,
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let totalBytes = 0;

        // Reset timeout on each data chunk — Tally sends data in bursts
        res.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
          totalBytes += chunk.length;
          // Reset socket timeout since we're receiving data
          res.socket?.setTimeout(timeoutMs);
        });

        res.on("end", () => {
          const ms = Date.now() - t0;
          const body = Buffer.concat(chunks).toString("utf-8");
          console.log(`[tally] ✓ ${label}: ${totalBytes} bytes in ${ms}ms`);

          if (body.includes("<LINEERROR>")) {
            const err = body.match(/<LINEERROR>([^<]*)/)?.[1] || "unknown";
            console.error(`[tally] ✗  TALLY ERROR: ${err}`);
          }

          if (rawMode) return settle(() => resolve(body));

          try {
            const parsed = xmlParser.parse(body);
            settle(() => resolve(parsed));
          } catch (parseErr: any) {
            console.error(`[tally] ✗ XML parse failed: ${parseErr.message}`);
            console.error(`[tally]   First 500 chars: ${body.slice(0, 500)}`);
            settle(() => reject(new Error(`XML parse failed: ${parseErr.message}`)));
          }
        });

        res.on("error", (err) => {
          settle(() => reject(new Error(`Response error: ${err.message}`)));
        });
      }
    );

    // Socket-level timeout — fires if NO DATA received for timeoutMs
    req.on("timeout", () => {
      console.error(`[tally] ✗ ${label}: TIMEOUT after ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      req.destroy(new Error(`Tally timeout: ${label} took longer than ${Math.round(timeoutMs / 1000)}s`));
    });

    req.on("error", (err: any) => {
      if (err.code === "ECONNREFUSED") {
        settle(() => reject(new Error("Cannot connect to Tally at " + tallyUrl + " — is TallyPrime running with ODBC enabled on port 9000?")));
      } else if (err.code === "ECONNRESET") {
        settle(() => reject(new Error("Tally reset the connection — the company may not be loaded or the request was invalid")));
      } else {
        settle(() => reject(new Error(`Tally request failed (${label}): ${err.message}`)));
      }
    });

    console.log(`[tally] → ${label} (${reqBody.length} bytes, timeout ${Math.round(timeoutMs / 1000)}s)`);
    req.write(reqBody);
    req.end();
  });
}

export async function tallyPostWithRetry(
  tallyUrl: string, xml: string, timeoutMs = 300_000, rawMode = false, maxRetries = 2, signal?: AbortSignal
): Promise<any> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (signal?.aborted) throw new Error("Aborted");
      if (attempt > 0) {
        console.log(`[tally] Retry ${attempt}/${maxRetries}...`);
        await new Promise(r => setTimeout(r, 2000 * attempt));
      }
      return await tallyPost(tallyUrl, xml, timeoutMs, rawMode, signal);
    } catch (e: any) {
      lastError = e;
      // Abort errors are never retriable
      if (e.message?.includes('Aborted')) throw e;
      const retriable = e.message?.includes('timeout') ||
                        e.message?.includes('ECONNREFUSED') ||
                        e.message?.includes('ECONNRESET') ||
                        e.message?.includes('XML parse failed');
      if (!retriable || attempt === maxRetries) throw e;
      console.error(`[tally] ✗ Attempt ${attempt + 1} failed: ${e.message}`);
    }
  }
  throw lastError;
}

// ─────────────────────────────────────────────────────────────────────
// XML REQUEST BUILDERS
// Using EXACT formats from official Tally documentation:
// https://help.tallysolutions.com/integration-with-tallyprime/
// ─────────────────────────────────────────────────────────────────────

/**
 * Simple health check — use Collection type for company list
 * Reference: TallyPrime XML API Guide - Collection-based exports
 */
export const HEALTH_XML = `<ENVELOPE>
<HEADER>
<VERSION>1</VERSION>
<TALLYREQUEST>Export</TALLYREQUEST>
<TYPE>Collection</TYPE>
<ID>List of Companies</ID>
</HEADER>
<BODY>
<DESC>
<STATICVARIABLES>
<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
</STATICVARIABLES>
<TDL>
<TDLMESSAGE>
<COLLECTION NAME="List of Companies" ISMODIFY="Yes">
<NATIVEMETHOD>Name</NATIVEMETHOD>
</COLLECTION>
</TDLMESSAGE>
</TDL>
</DESC>
</BODY>
</ENVELOPE>`;

/**
 * Stock Groups — Collection export for all stock groups
 */
export function stockGroupsXml(company: string): string {
  return `<ENVELOPE>
<HEADER>
<VERSION>1</VERSION>
<TALLYREQUEST>Export</TALLYREQUEST>
<TYPE>Collection</TYPE>
<ID>List of Stock Groups</ID>
</HEADER>
<BODY>
<DESC>
<STATICVARIABLES>
<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY>
</STATICVARIABLES>
<TDL>
<TDLMESSAGE>
<COLLECTION NAME="List of Stock Groups" ISMODIFY="Yes">
<NATIVEMETHOD>Name</NATIVEMETHOD>
<NATIVEMETHOD>Parent</NATIVEMETHOD>
<NATIVEMETHOD>IsAddable</NATIVEMETHOD>
<NATIVEMETHOD>GUID</NATIVEMETHOD>
</COLLECTION>
</TDLMESSAGE>
</TDL>
</DESC>
</BODY>
</ENVELOPE>`;
}

/**
 * Units — Collection export for all units of measure
 */
export function unitsXml(company: string): string {
  return `<ENVELOPE>
<HEADER>
<VERSION>1</VERSION>
<TALLYREQUEST>Export</TALLYREQUEST>
<TYPE>Collection</TYPE>
<ID>MKCPUnits</ID>
</HEADER>
<BODY>
<DESC>
<STATICVARIABLES>
<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY>
</STATICVARIABLES>
<TDL>
<TDLMESSAGE>
<COLLECTION NAME="MKCPUnits" ISMODIFY="No">
<TYPE>Unit</TYPE>
<NATIVEMETHOD>Name</NATIVEMETHOD>
<NATIVEMETHOD>OriginalName</NATIVEMETHOD>
<NATIVEMETHOD>BaseUnits</NATIVEMETHOD>
<NATIVEMETHOD>AdditionalUnits</NATIVEMETHOD>
<NATIVEMETHOD>Conversion</NATIVEMETHOD>
<NATIVEMETHOD>IsFormallyCompound</NATIVEMETHOD>
<NATIVEMETHOD>IsSimpleUnit</NATIVEMETHOD>
<NATIVEMETHOD>GUID</NATIVEMETHOD>
</COLLECTION>
</TDLMESSAGE>
</TDL>
</DESC>
</BODY>
</ENVELOPE>`;
}

/**
 * Godowns — Collection export for all godowns
 */
export function godownsXml(company: string): string {
  return `<ENVELOPE>
<HEADER>
<VERSION>1</VERSION>
<TALLYREQUEST>Export</TALLYREQUEST>
<TYPE>Collection</TYPE>
<ID>MKCPGodowns</ID>
</HEADER>
<BODY>
<DESC>
<STATICVARIABLES>
<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY>
</STATICVARIABLES>
<TDL>
<TDLMESSAGE>
<COLLECTION NAME="MKCPGodowns" ISMODIFY="No">
<TYPE>Godown</TYPE>
<NATIVEMETHOD>Name</NATIVEMETHOD>
<NATIVEMETHOD>Parent</NATIVEMETHOD>
<NATIVEMETHOD>HasNoSpace</NATIVEMETHOD>
<NATIVEMETHOD>GUID</NATIVEMETHOD>
</COLLECTION>
</TDLMESSAGE>
</TDL>
</DESC>
</BODY>
</ENVELOPE>`;
}

/**
 * Cost Centres — Collection export for all cost centres
 */
export function costCentresXml(company: string): string {
  return `<ENVELOPE>
<HEADER>
<VERSION>1</VERSION>
<TALLYREQUEST>Export</TALLYREQUEST>
<TYPE>Collection</TYPE>
<ID>MKCPCostCentres</ID>
</HEADER>
<BODY>
<DESC>
<STATICVARIABLES>
<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY>
</STATICVARIABLES>
<TDL>
<TDLMESSAGE>
<COLLECTION NAME="MKCPCostCentres" ISMODIFY="No">
<TYPE>CostCentre</TYPE>
<NATIVEMETHOD>Name</NATIVEMETHOD>
<NATIVEMETHOD>Parent</NATIVEMETHOD>
<NATIVEMETHOD>Category</NATIVEMETHOD>
<NATIVEMETHOD>GUID</NATIVEMETHOD>
</COLLECTION>
</TDLMESSAGE>
</TDL>
</DESC>
</BODY>
</ENVELOPE>`;
}

/**
 * Stock items — using Collection export (All Masters is import-only)
 * Reference: TallyPrime XML API Guide - Collection-based exports
 */
export function stockItemsXml(company: string): string {
  return `<ENVELOPE>
<HEADER>
<VERSION>1</VERSION>
<TALLYREQUEST>Export</TALLYREQUEST>
<TYPE>Collection</TYPE>
<ID>List of Stock Items</ID>
</HEADER>
<BODY>
<DESC>
<STATICVARIABLES>
<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY>
</STATICVARIABLES>
<TDL>
<TDLMESSAGE>
<COLLECTION NAME="List of Stock Items" ISMODIFY="Yes">
<NATIVEMETHOD>Name</NATIVEMETHOD>
<NATIVEMETHOD>Parent</NATIVEMETHOD>
<NATIVEMETHOD>Category</NATIVEMETHOD>
<NATIVEMETHOD>BaseUnits</NATIVEMETHOD>
<NATIVEMETHOD>AdditionalUnits</NATIVEMETHOD>
<NATIVEMETHOD>Denominator</NATIVEMETHOD>
<NATIVEMETHOD>OpeningBalance</NATIVEMETHOD>
<NATIVEMETHOD>OpeningRate</NATIVEMETHOD>
<NATIVEMETHOD>OpeningValue</NATIVEMETHOD>
<NATIVEMETHOD>GSTApplicable</NATIVEMETHOD>
<NATIVEMETHOD>GSTTypeOfSupply</NATIVEMETHOD>
<NATIVEMETHOD>GSTDetails</NATIVEMETHOD>
<NATIVEMETHOD>HSNDetails</NATIVEMETHOD>
<NATIVEMETHOD>GUID</NATIVEMETHOD>
</COLLECTION>
</TDLMESSAGE>
</TDL>
</DESC>
</BODY>
</ENVELOPE>`;
}

/**
 * Ledgers — from Tally docs:
 * TYPE=Collection, ID=List of Ledgers
 * Modified with ISMODIFY to get full details via NATIVEMETHOD
 */
export function ledgersXml(company: string): string {
  return `<ENVELOPE>
<HEADER>
<VERSION>1</VERSION>
<TALLYREQUEST>Export</TALLYREQUEST>
<TYPE>Collection</TYPE>
<ID>List of Ledgers</ID>
</HEADER>
<BODY>
<DESC>
<STATICVARIABLES>
<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY>
</STATICVARIABLES>
<TDL>
<TDLMESSAGE>
<COLLECTION NAME="List of Ledgers" ISMODIFY="Yes">
<NATIVEMETHOD>Name</NATIVEMETHOD>
<NATIVEMETHOD>Parent</NATIVEMETHOD>
<NATIVEMETHOD>OpeningBalance</NATIVEMETHOD>
<NATIVEMETHOD>GSTIN</NATIVEMETHOD>
<NATIVEMETHOD>LedGSTIN</NATIVEMETHOD>
<NATIVEMETHOD>PartyGSTIN</NATIVEMETHOD>
<NATIVEMETHOD>CreditPeriod</NATIVEMETHOD>
<NATIVEMETHOD>BillCreditPeriod</NATIVEMETHOD>
<NATIVEMETHOD>GUID</NATIVEMETHOD>
<NATIVEMETHOD>MailingName</NATIVEMETHOD>
<NATIVEMETHOD>Address</NATIVEMETHOD>
<NATIVEMETHOD>LedStateName</NATIVEMETHOD>
<NATIVEMETHOD>CountryName</NATIVEMETHOD>
<NATIVEMETHOD>PinCode</NATIVEMETHOD>
<NATIVEMETHOD>Email</NATIVEMETHOD>
<NATIVEMETHOD>LedgerPhone</NATIVEMETHOD>
</COLLECTION>
</TDLMESSAGE>
</TDL>
</DESC>
</BODY>
</ENVELOPE>`;
}

/**
 * Vouchers — Period-based Day Book export using official Tally XML format.
 * Reference: TallyPrime Integration Guide - "Exporting Transactions (Day Book)"
 *
 * Uses <TALLYREQUEST>Export</TALLYREQUEST> with <TYPE>Data</TYPE> and <ID>Day Book</ID>.
 * This is the officially documented format for exporting Day Book data.
 * SVFROMDATE/SVTODATE use TYPE="Date" attribute as per documentation.
 * EXPLODEFLAG=Yes ensures all sub-voucher details (ledger entries, inventory entries,
 * bill allocations) are expanded in the response.
 */
export function vouchersXml(company: string, from: string, to: string): string {
  const tallyFrom = toTallyDate(from);
  const tallyTo = toTallyDate(to);
  console.log(`[tally] vouchersXml: YYYYMMDD ${from}->${to} | Tally format: ${tallyFrom}->${tallyTo}`);
  return `<ENVELOPE>
<HEADER>
<VERSION>1</VERSION>
<TALLYREQUEST>Export</TALLYREQUEST>
<TYPE>Data</TYPE>
<ID>Day Book</ID>
</HEADER>
<BODY>
<DESC>
<STATICVARIABLES>
<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY>
<SVFROMDATE TYPE="Date">${tallyFrom}</SVFROMDATE>
<SVTODATE TYPE="Date">${tallyTo}</SVTODATE>
<EXPLODEFLAG>Yes</EXPLODEFLAG>
</STATICVARIABLES>
</DESC>
</BODY>
</ENVELOPE>`;
}

/**
 * PRIMARY: Collection-based voucher export with reliable date filtering.
 * Directly queries the VOUCHER collection using TDL with explicit FETCH.
 *
 * KEY INSIGHT: TallyPrime's $$InDateRange and SVFROMDATE/SVTODATE are broken for
 * Collection exports (always returns 0). We use $$YearOfDate/$$MonthOfDate/$$DayOfDate
 * to build a numeric YYYYMMDD comparison that reliably filters by date.
 *
 * FETCH INSIGHT: Wildcard `*` only fetches primitive attributes, NOT sub-collections
 * (like ALLLEDGERENTRIES, LEDGERENTRIES, INVENTORYENTRIES). These must be explicitly
 * named in the FETCH list to be included in the response.
 *
 * Sub-collections fetched:
 * - AllLedgerEntries (Receipt/Payment vouchers) + BillAllocations
 * - LedgerEntries (Sales/Purchase vouchers) + BillAllocations
 * - AllInventoryEntries (Sales/Purchase invoice mode) + BatchAllocations
 * - InventoryEntries + AccountingAllocations
 *
 * @param from YYYYMMDD start date
 * @param to   YYYYMMDD end date
 */
export function vouchersCollectionXml(company: string, from: string, to: string): string {
  const fromInt = parseInt(from, 10);
  const toInt = parseInt(to, 10);
  console.log(`[tally] vouchersCollectionXml: date range ${from}->${to} (numeric: ${fromInt}->${toInt})`);
  // Explicit FETCH list: * for all primitive attrs, then each sub-collection + its children
  const fetchList = [
    "*",
    "AllLedgerEntries", "AllLedgerEntries.*",
    "AllLedgerEntries.BillAllocations", "AllLedgerEntries.BillAllocations.*",
    "LedgerEntries", "LedgerEntries.*",
    "LedgerEntries.BillAllocations", "LedgerEntries.BillAllocations.*",
    "AllInventoryEntries", "AllInventoryEntries.*",
    "InventoryEntries", "InventoryEntries.*",
  ].join(", ");
  return `<ENVELOPE>
<HEADER>
<VERSION>1</VERSION>
<TALLYREQUEST>Export</TALLYREQUEST>
<TYPE>Collection</TYPE>
<ID>MKCPVouchers</ID>
</HEADER>
<BODY>
<DESC>
<STATICVARIABLES>
<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY>
</STATICVARIABLES>
<TDL>
<TDLMESSAGE>
<COLLECTION NAME="MKCPVouchers" ISMODIFY="No">
<TYPE>Voucher</TYPE>
<FETCH>${fetchList}</FETCH>
<FILTER>MKCPDateFilter</FILTER>
</COLLECTION>
<SYSTEM TYPE="Formulae" NAME="MKCPDateFilter">($$YearOfDate:$Date * 10000 + $$MonthOfDate:$Date * 100 + $$DayOfDate:$Date) &gt;= ${fromInt} AND ($$YearOfDate:$Date * 10000 + $$MonthOfDate:$Date * 100 + $$DayOfDate:$Date) &lt;= ${toInt}</SYSTEM>
</TDLMESSAGE>
</TDL>
</DESC>
</BODY>
</ENVELOPE>`;
}

// ─────────────────────────────────────────────────────────────────────
// Monthly Chunking — splits a FY date range into monthly requests
// ─────────────────────────────────────────────────────────────────────

export interface DateChunk {
  from: string;  // YYYYMMDD
  to: string;    // YYYYMMDD
  label: string; // e.g. "Apr 2025"
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function getMonthlyChunks(fromDate: string, toDate: string): DateChunk[] {
  const chunks: DateChunk[] = [];

  let year = parseInt(fromDate.slice(0, 4), 10);
  let month = parseInt(fromDate.slice(4, 6), 10); // 1-based
  const endYear = parseInt(toDate.slice(0, 4), 10);
  const endMonth = parseInt(toDate.slice(4, 6), 10);
  const endDay = parseInt(toDate.slice(6, 8), 10);
  const startDay = parseInt(fromDate.slice(6, 8), 10);

  let isFirst = true;
  while (year < endYear || (year === endYear && month <= endMonth)) {
    const chunkFromDay = isFirst ? startDay : 1;
    const isLast = year === endYear && month === endMonth;
    const lastDayOfMonth = new Date(year, month, 0).getDate();
    const chunkToDay = isLast ? endDay : lastDayOfMonth;

    const mm = String(month).padStart(2, "0");
    const from = `${year}${mm}${String(chunkFromDay).padStart(2, "0")}`;
    const to = `${year}${mm}${String(chunkToDay).padStart(2, "0")}`;
    const label = `${MONTH_NAMES[month - 1]} ${year}`;

    chunks.push({ from, to, label });

    isFirst = false;
    month++;
    if (month > 12) {
      month = 1;
      year++;
    }
  }

  return chunks;
}

/**
 * Daily Chunking — splits a date range into individual day requests.
 * Slower but more reliable for large datasets or problematic date ranges.
 */
export function getDailyChunks(fromDate: string, toDate: string): DateChunk[] {
  const chunks: DateChunk[] = [];

  const startYear = parseInt(fromDate.slice(0, 4), 10);
  const startMonth = parseInt(fromDate.slice(4, 6), 10) - 1;
  const startDay = parseInt(fromDate.slice(6, 8), 10);
  const endYear = parseInt(toDate.slice(0, 4), 10);
  const endMonth = parseInt(toDate.slice(4, 6), 10) - 1;
  const endDay = parseInt(toDate.slice(6, 8), 10);

  const current = new Date(startYear, startMonth, startDay);
  const end = new Date(endYear, endMonth, endDay);

  while (current <= end) {
    const y = current.getFullYear();
    const m = String(current.getMonth() + 1).padStart(2, "0");
    const d = String(current.getDate()).padStart(2, "0");
    const dateStr = `${y}${m}${d}`;
    const label = `${d} ${MONTH_NAMES[current.getMonth()]} ${y}`;

    chunks.push({ from: dateStr, to: dateStr, label });

    current.setDate(current.getDate() + 1);
  }

  return chunks;
}

/**
 * Weekly Chunking — splits a date range into 7-day blocks.
 * Good balance between monthly (too large) and daily (too many requests).
 */
export function getWeeklyChunks(fromDate: string, toDate: string): DateChunk[] {
  const chunks: DateChunk[] = [];

  const startYear = parseInt(fromDate.slice(0, 4), 10);
  const startMonth = parseInt(fromDate.slice(4, 6), 10) - 1;
  const startDay = parseInt(fromDate.slice(6, 8), 10);
  const endYear = parseInt(toDate.slice(0, 4), 10);
  const endMonth = parseInt(toDate.slice(4, 6), 10) - 1;
  const endDay = parseInt(toDate.slice(6, 8), 10);

  const current = new Date(startYear, startMonth, startDay);
  const end = new Date(endYear, endMonth, endDay);

  while (current <= end) {
    const weekEnd = new Date(current);
    weekEnd.setDate(weekEnd.getDate() + 6);
    if (weekEnd > end) weekEnd.setTime(end.getTime());

    const fromStr = `${current.getFullYear()}${String(current.getMonth() + 1).padStart(2, "0")}${String(current.getDate()).padStart(2, "0")}`;
    const toStr = `${weekEnd.getFullYear()}${String(weekEnd.getMonth() + 1).padStart(2, "0")}${String(weekEnd.getDate()).padStart(2, "0")}`;
    const label = `${current.getDate()} ${MONTH_NAMES[current.getMonth()]} — ${weekEnd.getDate()} ${MONTH_NAMES[weekEnd.getMonth()]} ${weekEnd.getFullYear()}`;

    chunks.push({ from: fromStr, to: toStr, label });

    current.setDate(current.getDate() + 7);
  }

  return chunks;
}

/**
 * Convert YYYYMMDD → D-Mon-YYYY (e.g., "20250401" → "1-Apr-2025").
 * TallyPrime's SVFROMDATE/SVTODATE static variables require this format.
 * The YYYYMMDD format only works for <DATE> tags inside voucher data,
 * NOT for static variable date parameters.
 */
function toTallyDate(yyyymmdd: string): string {
  const y = yyyymmdd.slice(0, 4);
  const m = parseInt(yyyymmdd.slice(4, 6), 10); // 1-based
  const d = parseInt(yyyymmdd.slice(6, 8), 10); // no leading zero
  return `${d}-${MONTH_NAMES[m - 1]}-${y}`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ─── Financial Reports (lightweight) ────────────────────────────────────

/** Fetch Tally P&L report — returns opening/closing stock, sales, purchases, expenses */
export function profitAndLossXml(company: string): string {
  return `<ENVELOPE>
<HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
<BODY><EXPORTDATA><REQUESTDESC>
<REPORTNAME>Profit and Loss</REPORTNAME>
<STATICVARIABLES>
<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY>
</STATICVARIABLES>
</REQUESTDESC></EXPORTDATA></BODY>
</ENVELOPE>`;
}

/** Fetch Tally Balance Sheet report */
export function balanceSheetXml(company: string): string {
  return `<ENVELOPE>
<HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
<BODY><EXPORTDATA><REQUESTDESC>
<REPORTNAME>Balance Sheet</REPORTNAME>
<STATICVARIABLES>
<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY>
</STATICVARIABLES>
</REQUESTDESC></EXPORTDATA></BODY>
</ENVELOPE>`;
}

/** Parse P&L report XML to extract key financial numbers */
export function parsePLReport(xml: string): {
  sales: number;
  costOfSales: number;
  openingStock: number;
  purchases: number;
  closingStock: number;
  directExpenses: number;
  indirectIncome: number;
  indirectExpenses: number;
  netProfit: number;
} | null {
  try {
    const parsed = xmlParser.parse(xml);
    const env = parsed?.ENVELOPE;
    if (!env) return null;

    // P&L report has alternating DSPACCNAME and PLAMT blocks
    // Extract the main amounts by name
    const result = {
      sales: 0, costOfSales: 0, openingStock: 0, purchases: 0,
      closingStock: 0, directExpenses: 0, indirectIncome: 0, indirectExpenses: 0, netProfit: 0,
    };

    // Parse flat arrays — DSPACCNAME and PLAMT alternate
    const names = Array.isArray(env.DSPACCNAME) ? env.DSPACCNAME : [env.DSPACCNAME];
    const amounts = Array.isArray(env.PLAMT) ? env.PLAMT : [env.PLAMT];

    for (let i = 0; i < names.length; i++) {
      const name = (names[i]?.DSPDISPNAME ?? "").trim().toLowerCase();
      const mainAmt = parseFloat(amounts[i]?.BSMAINAMT ?? "0") || 0;
      const subAmt = parseFloat(amounts[i]?.PLSUBAMT ?? "0") || 0;

      if (name.includes("sales accounts")) result.sales = Math.abs(mainAmt);
      else if (name === "cost of sales :") result.costOfSales = Math.abs(mainAmt);
      else if (name.includes("opening stock")) result.openingStock = Math.abs(subAmt);
      else if (name.includes("purchase accounts")) result.purchases = Math.abs(subAmt);
      else if (name.includes("closing stock")) result.closingStock = Math.abs(subAmt);
      else if (name.includes("direct expenses")) result.directExpenses = Math.abs(subAmt || mainAmt);
      else if (name.includes("indirect incomes") || name.includes("indirect income")) result.indirectIncome = Math.abs(mainAmt);
      else if (name.includes("indirect expenses") || name.includes("indirect expense")) result.indirectExpenses = Math.abs(mainAmt);
    }

    // Net Profit = Sales - CostOfSales + IndirectIncome - IndirectExpenses
    result.netProfit = result.sales - result.costOfSales + result.indirectIncome - result.indirectExpenses;
    return result;
  } catch {
    return null;
  }
}

/** Parse Balance Sheet report XML */
export function parseBSReport(xml: string): {
  capitalAccount: number;
  loans: number;
  currentLiabilities: number;
  profitAndLoss: number;
  fixedAssets: number;
  investments: number;
  currentAssets: number;
} | null {
  try {
    const parsed = xmlParser.parse(xml);
    const env = parsed?.ENVELOPE;
    if (!env) return null;

    const result = {
      capitalAccount: 0, loans: 0, currentLiabilities: 0, profitAndLoss: 0,
      fixedAssets: 0, investments: 0, currentAssets: 0,
    };

    const names = Array.isArray(env.BSNAME) ? env.BSNAME : [env.BSNAME];
    const amounts = Array.isArray(env.BSAMT) ? env.BSAMT : [env.BSAMT];

    for (let i = 0; i < names.length; i++) {
      const name = (names[i]?.DSPACCNAME?.DSPDISPNAME ?? "").trim().toLowerCase();
      const mainAmt = parseFloat(amounts[i]?.BSMAINAMT ?? "0") || 0;

      if (name.includes("capital account")) result.capitalAccount = Math.abs(mainAmt);
      else if (name.includes("loans")) result.loans = Math.abs(mainAmt);
      else if (name.includes("current liabilities")) result.currentLiabilities = Math.abs(mainAmt);
      else if (name.includes("profit") && name.includes("loss")) result.profitAndLoss = Math.abs(mainAmt);
      else if (name.includes("fixed assets")) result.fixedAssets = Math.abs(mainAmt);
      else if (name.includes("investments")) result.investments = Math.abs(mainAmt);
      else if (name.includes("current assets")) result.currentAssets = Math.abs(mainAmt);
    }

    return result;
  } catch {
    return null;
  }
}
