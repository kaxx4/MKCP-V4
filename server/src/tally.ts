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
    // Stored so settle() can remove it — { once: true } only auto-removes when the event fires;
    // for successful requests the signal is never aborted so the listener would leak, causing
    // "MaxListenersExceededWarning: 11 abort listeners added to [AbortSignal]" after ~10 requests.
    let abortHandler: (() => void) | undefined;

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
      // Remove the abort listener so it doesn't accumulate on the shared AbortSignal
      if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
      fn();
    }

    // Handle external abort (client disconnect)
    if (signal) {
      if (signal.aborted) {
        clearTimeout(hardDeadline);
        return reject(new Error(`Aborted: ${label}`));
      }
      abortHandler = () => {
        if (!settled) {
          settled = true;
          clearTimeout(hardDeadline);
          if (abortHandler) signal.removeEventListener("abort", abortHandler);
          req.destroy();
          reject(new Error(`Aborted: ${label}`));
        }
      };
      signal.addEventListener("abort", abortHandler);
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

