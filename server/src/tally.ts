import { XMLParser } from "fast-xml-parser";

// ─── XML Parser configured for Tally responses ────────────────────
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  parseTagValue: false,    // Keep ALL values as strings — let downstream parsers handle conversion
  trimValues: true,
  isArray: (tag) => {
    // Tags that MUST be arrays even when Tally returns a single element
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
  "DSPVCHLEDACCOUNT", "DSPVCHLEDDATE", // DayBook response tags
]);

// ─── Send XML to Tally, get parsed JSON ───────────────────────────
export async function postToTally(url: string, xml: string): Promise<any> {
  const label = xml.match(/<ID[^>]*>([^<]+)/)?.[1] || "?";
  const t0 = Date.now();
  console.log(`[tally] >>> ${label} (${xml.length}b)`);

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "text/xml; charset=utf-8" },
    body: xml,
    signal: AbortSignal.timeout(90_000), // 90s timeout
  });

  const text = await res.text();
  const ms = Date.now() - t0;
  console.log(`[tally] <<< ${label}: ${text.length}b in ${ms}ms`);

  if (text.includes("<LINEERROR>")) {
    const err = text.match(/<LINEERROR>([^<]*)/)?.[1] || "unknown";
    console.error(`[tally] !!! TALLY ERROR: ${err}`);
  }

  return parser.parse(text);
}

// ═══════════════════════════════════════════════════════════════════
// XML REQUESTS — Using ONLY official Tally built-in endpoints
// From: https://help.tallysolutions.com/integration-with-tallyprime/
// ═══════════════════════════════════════════════════════════════════

/** Health check — simplest possible request */
export const HEALTH_XML = `<ENVELOPE>
<HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>List of Companies</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES></DESC></BODY>
</ENVELOPE>`;

/** Get all companies — built-in report */
export const COMPANY_XML = HEALTH_XML;

/** Get all stock items with full details — uses built-in "List of Accounts" report */
export function stockItemsXml(company: string): string {
  return `<ENVELOPE>
<HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>List of Accounts</ID></HEADER>
<BODY><DESC>
<STATICVARIABLES>
<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY>
<AccountType>Stock Items</AccountType>
</STATICVARIABLES>
</DESC></BODY>
</ENVELOPE>`;
}

/** Get all ledgers — built-in "List of Ledgers" collection */
export function ledgersXml(company: string): string {
  return `<ENVELOPE>
<HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>List of Ledgers</ID></HEADER>
<BODY><DESC>
<STATICVARIABLES>
<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY>
</STATICVARIABLES>
</DESC></BODY>
</ENVELOPE>`;
}

/** Get all vouchers — built-in "Day Book" report with date filter */
export function vouchersXml(company: string, from?: string, to?: string): string {
  // Tally date format: YYYYMMDD — the doc example uses "1-Apr-2016" but YYYYMMDD also works
  const dateFilter = from && to
    ? `<SVFROMDATE>${from}</SVFROMDATE><SVTODATE>${to}</SVTODATE>`
    : "";
  return `<ENVELOPE>
<HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>Day Book</ID></HEADER>
<BODY><DESC>
<STATICVARIABLES>
<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY>
${dateFilter}
</STATICVARIABLES>
</DESC></BODY>
</ENVELOPE>`;
}

// ═══════════════════════════════════════════════════════════════════
// RESPONSE CONVERTERS — XML parsed JSON → tallymessage format
// The frontend parsers (masterParser.ts, transactionParser.ts) expect:
//   { tallymessage: [ { metadata: { type: "Stock Item" }, name, parent, ... }, ... ] }
// ═══════════════════════════════════════════════════════════════════

/** Dig through nested Tally XML response to find the data payload */
function dig(obj: any, ...paths: string[][]): any {
  for (const path of paths) {
    let cur = obj;
    for (const key of path) {
      if (!cur) break;
      // Try exact key, then .LIST variant
      cur = cur[key] ?? cur[key + ".LIST"] ?? cur[key.toUpperCase()] ?? cur[key.toUpperCase() + ".LIST"];
    }
    if (cur !== undefined && cur !== null) return cur;
  }
  return null;
}

function arr(v: any): any[] {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  return [v];
}

/** Convert "List of Accounts" (Stock Items) response → tallymessage */
export function convertStockItems(parsed: any): { tallymessage: any[] } {
  const messages: any[] = [];

  // "List of Accounts" with AccountType=Stock Items returns:
  // ENVELOPE > BODY > DATA > TALLYMESSAGE > STOCKITEM[]
  const data = dig(parsed,
    ["ENVELOPE", "BODY", "DATA", "TALLYMESSAGE"],
    ["ENVELOPE", "BODY", "DATA"],
    ["ENVELOPE", "BODY", "TALLYMESSAGE"],
    ["ENVELOPE", "BODY"],
  );

  const items = arr(data?.STOCKITEM ?? data?.["STOCKITEM.LIST"] ?? []);
  console.log(`[convert] Stock items found: ${items.length}`);

  for (const si of items) {
    const name = si["@_NAME"] || si.NAME || si.LANGUAGENAME?.["NAME.LIST"]?.NAME || "";
    if (!name) continue;
    messages.push({
      metadata: { type: "Stock Item", name },
      name,
      parent: si.PARENT || "Primary",
      baseunits: si.BASEUNITS || "PC",
      additionalunits: si.ADDITIONALUNITS || " Not Applicable",
      denominator: si.DENOMINATOR || "1",
      openingbalance: si.OPENINGBALANCE || si["OPENINGBALANCE"] || "0",
      openingrate: si.OPENINGRATE || "0",
      openingvalue: si.OPENINGVALUE || "0",
      gstapplicable: si.GSTAPPLICABLE || "",
      gsttypeofsupply: si.GSTTYPEOFSUPPLY || "",
      costingmethod: si.COSTINGMETHOD || "",
      valuationmethod: si.VALUATIONMETHOD || "",
      isbatchwiseon: si.ISBATCHWISEON === "Yes",
      iscostcentreson: si.ISCOSTCENTRESON === "Yes",
      gstdetails: arr(si.GSTDETAILS ?? si["GSTDETAILS.LIST"]).map((g: any) => ({
        ...g,
        statewisedetails: arr(g?.STATEWISEDETAILS ?? g?.["STATEWISEDETAILS.LIST"]).map((s: any) => ({
          ...s,
          ratedetails: arr(s?.RATEDETAILS ?? s?.["RATEDETAILS.LIST"]).map((r: any) => ({
            gstratedutyhead: r.GSTRATEDUTYHEAD || "",
            gstrate: r.GSTRATE || "0",
          })),
        })),
      })),
      hsndetails: arr(si.HSNDETAILS ?? si["HSNDETAILS.LIST"]).map((h: any) => ({
        hsncode: h.HSNCODE || h.DESCRIPTION || "",
      })),
      guid: si.GUID || "",
    });
  }
  return { tallymessage: messages };
}

/** Convert "List of Ledgers" response → tallymessage */
export function convertLedgers(parsed: any): { tallymessage: any[] } {
  const messages: any[] = [];

  // Built-in collection returns: ENVELOPE > BODY > DATA > COLLECTION > LEDGER[]
  // OR sometimes: ENVELOPE > BODY > DATA > TALLYMESSAGE > LEDGER[]
  const data = dig(parsed,
    ["ENVELOPE", "BODY", "DATA", "COLLECTION"],
    ["ENVELOPE", "BODY", "DATA", "TALLYMESSAGE"],
    ["ENVELOPE", "BODY", "DATA"],
    ["ENVELOPE", "BODY", "TALLYMESSAGE"],
    ["ENVELOPE", "BODY"],
  );

  const ledgers = arr(data?.LEDGER ?? data?.["LEDGER.LIST"] ?? []);
  console.log(`[convert] Ledgers found: ${ledgers.length}`);

  for (const led of ledgers) {
    const name = led["@_NAME"] || led.NAME || led.LANGUAGENAME?.["NAME.LIST"]?.NAME || "";
    if (!name) continue;
    messages.push({
      metadata: { type: "Ledger", name },
      name,
      parent: led.PARENT || "Unsorted",
      openingbalance: led.OPENINGBALANCE || "0",
      gstin: led.PARTYGSTIN || led.GSTIN || led.LEDGERGSTIN || "",
      creditperiod: led.CREDITPERIOD || led.BILLCREDITPERIOD || "",
      guid: led.GUID || "",
    });
  }
  return { tallymessage: messages };
}

/** Convert "Day Book" response → tallymessage */
export function convertVouchers(parsed: any): { tallymessage: any[] } {
  const messages: any[] = [];

  // DayBook returns: ENVELOPE > BODY > DATA > TALLYMESSAGE > VOUCHER[]
  const data = dig(parsed,
    ["ENVELOPE", "BODY", "DATA", "TALLYMESSAGE"],
    ["ENVELOPE", "BODY", "DATA"],
    ["ENVELOPE", "BODY", "TALLYMESSAGE"],
    ["ENVELOPE", "BODY"],
  );

  const vouchers = arr(data?.VOUCHER ?? data?.["VOUCHER.LIST"] ?? []);
  console.log(`[convert] Vouchers found: ${vouchers.length}`);

  for (const v of vouchers) {
    // Extract ledger entries — Tally uses .LIST suffix
    const le = arr(v["ALLLEDGERENTRIES.LIST"] ?? v.ALLLEDGERENTRIES ?? v["LEDGERENTRIES.LIST"] ?? v.LEDGERENTRIES);
    const ie = arr(v["ALLINVENTORYENTRIES.LIST"] ?? v.ALLINVENTORYENTRIES ?? v["INVENTORYENTRIES.LIST"] ?? v.INVENTORYENTRIES);

    const ledgerentries = le.map((e: any) => ({
      ledgername: e.LEDGERNAME || "",
      isdeemedpositive: e.ISDEEMEDPOSITIVE === "Yes",
      ispartyledger: e.ISPARTYLEDGER === "Yes",
      amount: e.AMOUNT || "0",
      billallocations: arr(e["BILLALLOCATIONS.LIST"] ?? e.BILLALLOCATIONS).map((b: any) => ({
        name: b.NAME || "",
        billtype: b.BILLTYPE || "New Ref",
        amount: b.AMOUNT || "0",
      })),
    }));

    const inventoryentries = ie.map((e: any) => ({
      stockitemname: e.STOCKITEMNAME || "",
      actualqty: e.ACTUALQTY || e.BILLEDQTY || "0",
      billedqty: e.BILLEDQTY || e.ACTUALQTY || "0",
      rate: e.RATE || "0",
      amount: e.AMOUNT || "0",
      isdeemedpositive: e.ISDEEMEDPOSITIVE === "Yes",
    }));

    messages.push({
      metadata: { type: "Voucher" },
      date: v.DATE || v["@_DATE"] || "",
      guid: v.GUID || v["@_GUID"] || "",
      vouchernumber: v.VOUCHERNUMBER || v.REFERENCE || "",
      vouchertypename: v.VOUCHERTYPENAME || "",
      partyledgername: v.PARTYLEDGERNAME || "",
      narration: v.NARRATION || "",
      iscancelled: v.ISCANCELLED === "Yes",
      isoptional: v.ISOPTIONAL === "Yes",
      effectivedate: v.EFFECTIVEDATE || v.DATE || "",
      allledgerentries: ledgerentries,
      ledgerentries: ledgerentries,
      allinventoryentries: inventoryentries,
      inventoryentries: inventoryentries,
    });
  }
  return { tallymessage: messages };
}

/** Convert company list response */
export function convertCompanies(parsed: any): any[] {
  const data = dig(parsed,
    ["ENVELOPE", "BODY", "DATA", "COLLECTION"],
    ["ENVELOPE", "BODY", "DATA", "TALLYMESSAGE"],
    ["ENVELOPE", "BODY", "DATA"],
  );
  const companies = arr(data?.COMPANY ?? data?.["COMPANY.LIST"] ?? []);
  return companies.map((c: any) => ({
    name: c["@_NAME"] || c.NAME || "",
    startDate: c.STARTINGFROM || "",
    endDate: c.ENDINGAT || "",
  }));
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
