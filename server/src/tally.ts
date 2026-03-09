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
 */
export function tallyPost(tallyUrl: string, xml: string, timeoutMs = 300_000, rawMode = false): Promise<any> {
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
  tallyUrl: string, xml: string, timeoutMs = 300_000, rawMode = false, maxRetries = 2
): Promise<any> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        console.log(`[tally] Retry ${attempt}/${maxRetries}...`);
        await new Promise(r => setTimeout(r, 2000 * attempt));
      }
      return await tallyPost(tallyUrl, xml, timeoutMs, rawMode);
    } catch (e: any) {
      lastError = e;
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
<NATIVEMETHOD>ClosingBalance</NATIVEMETHOD>
<NATIVEMETHOD>ClosingRate</NATIVEMETHOD>
<NATIVEMETHOD>ClosingValue</NATIVEMETHOD>
<NATIVEMETHOD>GSTApplicable</NATIVEMETHOD>
<NATIVEMETHOD>GSTTypeOfSupply</NATIVEMETHOD>
<NATIVEMETHOD>CostingMethod</NATIVEMETHOD>
<NATIVEMETHOD>ValuationMethod</NATIVEMETHOD>
<NATIVEMETHOD>IsBatchWiseOn</NATIVEMETHOD>
<NATIVEMETHOD>IsCostCentresOn</NATIVEMETHOD>
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
 * Vouchers — from Tally docs:
 * TYPE=Data, ID=Day Book with date range
 * Date format: YYYYMMDD (TallyPrime XML API standard)
 */
export function vouchersXml(company: string, from: string, to: string): string {
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
<SVFROMDATE>${from}</SVFROMDATE>
<SVTODATE>${to}</SVTODATE>
</STATICVARIABLES>
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

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
