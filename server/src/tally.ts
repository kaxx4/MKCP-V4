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
  "TALLYMESSAGE", "VOUCHER", "LEDGER", "STOCKITEM", "COMPANY",
  "ALLLEDGERENTRIES", "LEDGERENTRIES", "ALLINVENTORYENTRIES", "INVENTORYENTRIES",
  "BILLALLOCATIONS", "BATCHALLOCATIONS", "ACCOUNTINGALLOCATIONS",
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

    const reqBody = Buffer.from(xml, "utf-8");

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

          if (rawMode) return resolve(body);

          try {
            const parsed = xmlParser.parse(body);
            resolve(parsed);
          } catch (parseErr: any) {
            console.error(`[tally] ✗ XML parse failed: ${parseErr.message}`);
            console.error(`[tally]   First 500 chars: ${body.slice(0, 500)}`);
            reject(new Error(`XML parse failed: ${parseErr.message}`));
          }
        });

        res.on("error", (err) => {
          reject(new Error(`Response error: ${err.message}`));
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
        reject(new Error("Cannot connect to Tally at " + tallyUrl + " — is TallyPrime running with ODBC enabled on port 9000?"));
      } else if (err.code === "ECONNRESET") {
        reject(new Error("Tally reset the connection — the company may not be loaded or the request was invalid"));
      } else {
        reject(new Error(`Tally request failed (${label}): ${err.message}`));
      }
    });

    console.log(`[tally] → ${label} (${reqBody.length} bytes, timeout ${Math.round(timeoutMs / 1000)}s)`);
    req.write(reqBody);
    req.end();
  });
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
<NATIVEMETHOD>BaseUnits</NATIVEMETHOD>
<NATIVEMETHOD>OpeningBalance</NATIVEMETHOD>
<NATIVEMETHOD>OpeningRate</NATIVEMETHOD>
<NATIVEMETHOD>OpeningValue</NATIVEMETHOD>
<NATIVEMETHOD>ClosingBalance</NATIVEMETHOD>
<NATIVEMETHOD>ClosingValue</NATIVEMETHOD>
<NATIVEMETHOD>GSTDetails</NATIVEMETHOD>
<NATIVEMETHOD>HSNDetails</NATIVEMETHOD>
<NATIVEMETHOD>GSTTypeOfSupply</NATIVEMETHOD>
<NATIVEMETHOD>Guid</NATIVEMETHOD>
<NATIVEMETHOD>MasterID</NATIVEMETHOD>
<NATIVEMETHOD>AlterID</NATIVEMETHOD>
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
 * This is the official way to get transactions.
 */
export function vouchersXml(company: string, from?: string, to?: string): string {
  const dates = from && to
    ? `<SVFROMDATE TYPE="Date">${from}</SVFROMDATE>\n<SVTODATE TYPE="Date">${to}</SVTODATE>`
    : "";
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
${dates}
</STATICVARIABLES>
</DESC>
</BODY>
</ENVELOPE>`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
