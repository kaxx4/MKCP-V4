import { XMLParser } from "fast-xml-parser";
import axios from "axios";

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  isArray: (name) => {
    const upper = name.toUpperCase();
    const stripped = upper.replace(/\.LIST$/, "");
    const arrayTags = new Set([
      "TALLYMESSAGE",
      "LEDGER", "STOCKITEM", "VOUCHER", "COMPANY",
      "LEDGERENTRY", "ALLLEDGERENTRIES", "ALLINVENTORYENTRIES",
      "INVENTORYENTRIES", "LEDGERENTRIES",
      "GSTDETAILS", "HSNDETAILS", "STATEDETAILS",
      "RATEDETAILS", "STATEWISEDETAILS",
      "BATCHALLOCATIONS", "CATEGORYALLOCATIONS",
      "BILLALLOCATIONS",
    ]);
    return arrayTags.has(upper) || arrayTags.has(stripped);
  },
  parseTagValue: true,
  trimValues: true,
});

/**
 * Send raw XML to Tally and get parsed JSON back – WITH LOGGING
 */
export async function postToTally(tallyUrl: string, xml: string): Promise<any> {
  // Log the request (truncated for readability)
  const collectionMatch = xml.match(/<ID>([^<]+)<\/ID>/);
  const idTag = collectionMatch ? collectionMatch[1] : "unknown";
  console.log(`[tally] >>> POST ${tallyUrl} | ID=${idTag} | ${xml.length} bytes`);

  const response = await axios.post(tallyUrl, xml, {
    headers: { "Content-Type": "text/xml; charset=utf-8" },
    timeout: 120000,
    responseType: "text",
    // Handle different encodings
    transformResponse: [(data) => data],
  });

  const raw: string = response.data;
  console.log(`[tally] <<< ${raw.length} bytes, status=${response.status}`);

  // Detect Tally errors
  if (raw.includes("<LINEERROR>") || raw.includes("<ERRORCODE>")) {
    const errorMatch = raw.match(/<LINEERROR>([^<]*)<\/LINEERROR>/);
    const errMsg = errorMatch ? errorMatch[1] : "Unknown Tally error";
    console.error(`[tally] <<< TALLY ERROR: ${errMsg}`);
    console.error(`[tally] <<< First 500 chars: ${raw.slice(0, 500)}`);
  }

  // Log first few tags to help debug structure
  const firstTags = raw.slice(0, 300).replace(/\s+/g, " ");
  console.log(`[tally] <<< Preview: ${firstTags}...`);

  const parsed = xmlParser.parse(raw);
  return parsed;
}

// ═══════════════════════════════════════════════════════════════════
// XML REQUEST BUILDERS
// ═══════════════════════════════════════════════════════════════════

export function buildCompanyRequestXml(): string {
  return `<ENVELOPE>
<HEADER>
<VERSION>1</VERSION>
<TALLYREQUEST>Export</TALLYREQUEST>
<TYPE>Collection</TYPE>
<ID>MKCPCompanyList</ID>
</HEADER>
<BODY>
<DESC>
<STATICVARIABLES>
<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
</STATICVARIABLES>
<TDL>
<TDLMESSAGE>
<COLLECTION NAME="MKCPCompanyList" ISMODIFY="No" ISFIXED="No" ISINITIALIZE="No" ISOPTION="No" ISINTERNAL="No">
<TYPE>Company</TYPE>
<NATIVEMETHOD>Name, GSTIN, StartingFrom, BooksFrom</NATIVEMETHOD>
</COLLECTION>
</TDLMESSAGE>
</TDL>
</DESC>
</BODY>
</ENVELOPE>`.trim();
}

export function buildStockItemsRequestXml(companyName: string): string {
  return `<ENVELOPE>
<HEADER>
<VERSION>1</VERSION>
<TALLYREQUEST>Export</TALLYREQUEST>
<TYPE>Collection</TYPE>
<ID>MKCPStockItems</ID>
</HEADER>
<BODY>
<DESC>
<STATICVARIABLES>
<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${escapeXml(companyName)}</SVCURRENTCOMPANY>
</STATICVARIABLES>
<TDL>
<TDLMESSAGE>
<COLLECTION NAME="MKCPStockItems" ISMODIFY="No" ISFIXED="No" ISINITIALIZE="No" ISOPTION="No" ISINTERNAL="No">
<TYPE>Stock Item</TYPE>
<NATIVEMETHOD>*</NATIVEMETHOD>
</COLLECTION>
</TDLMESSAGE>
</TDL>
</DESC>
</BODY>
</ENVELOPE>`.trim();
}

export function buildLedgersRequestXml(companyName: string): string {
  return `<ENVELOPE>
<HEADER>
<VERSION>1</VERSION>
<TALLYREQUEST>Export</TALLYREQUEST>
<TYPE>Collection</TYPE>
<ID>MKCPLedgers</ID>
</HEADER>
<BODY>
<DESC>
<STATICVARIABLES>
<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${escapeXml(companyName)}</SVCURRENTCOMPANY>
</STATICVARIABLES>
<TDL>
<TDLMESSAGE>
<COLLECTION NAME="MKCPLedgers" ISMODIFY="No" ISFIXED="No" ISINITIALIZE="No" ISOPTION="No" ISINTERNAL="No">
<TYPE>Ledger</TYPE>
<NATIVEMETHOD>*</NATIVEMETHOD>
</COLLECTION>
</TDLMESSAGE>
</TDL>
</DESC>
</BODY>
</ENVELOPE>`.trim();
}

export function buildVouchersRequestXml(
  companyName: string,
  fromDate?: string,
  toDate?: string
): string {
  const dateFilter = fromDate && toDate ? `
<SVFROMDATE>${fromDate}</SVFROMDATE>
<SVTODATE>${toDate}</SVTODATE>` : "";

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
<SVCURRENTCOMPANY>${escapeXml(companyName)}</SVCURRENTCOMPANY>${dateFilter}
</STATICVARIABLES>
<TDL>
<TDLMESSAGE>
<COLLECTION NAME="MKCPVouchers" ISMODIFY="No" ISFIXED="No" ISINITIALIZE="No" ISOPTION="No" ISINTERNAL="No">
<TYPE>Voucher</TYPE>
<NATIVEMETHOD>*</NATIVEMETHOD>
</COLLECTION>
</TDLMESSAGE>
</TDL>
</DESC>
</BODY>
</ENVELOPE>`.trim();
}

export function buildVouchersByTypeXml(
  companyName: string,
  voucherType: string,
  fromDate?: string,
  toDate?: string
): string {
  const dateFilter = fromDate && toDate ? `
<SVFROMDATE>${fromDate}</SVFROMDATE>
<SVTODATE>${toDate}</SVTODATE>` : "";

  return `<ENVELOPE>
<HEADER>
<VERSION>1</VERSION>
<TALLYREQUEST>Export</TALLYREQUEST>
<TYPE>Collection</TYPE>
<ID>MKCPTypedVouchers</ID>
</HEADER>
<BODY>
<DESC>
<STATICVARIABLES>
<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${escapeXml(companyName)}</SVCURRENTCOMPANY>${dateFilter}
</STATICVARIABLES>
<TDL>
<TDLMESSAGE>
<COLLECTION NAME="MKCPTypedVouchers" ISMODIFY="No" ISFIXED="No" ISINITIALIZE="No" ISOPTION="No" ISINTERNAL="No">
<TYPE>Voucher</TYPE>
<NATIVEMETHOD>*</NATIVEMETHOD>
<FILTERS>MKCPVchTypeFilter</FILTERS>
</COLLECTION>
<SYSTEM TYPE="Formulae" NAME="MKCPVchTypeFilter">
$VoucherTypeName = "${escapeXml(voucherType)}"
</SYSTEM>
</TDLMESSAGE>
</TDL>
</DESC>
</BODY>
</ENVELOPE>`.trim();
}

export function buildStockGroupsRequestXml(companyName: string): string {
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
<SVCURRENTCOMPANY>${escapeXml(companyName)}</SVCURRENTCOMPANY>
</STATICVARIABLES>
</DESC>
</BODY>
</ENVELOPE>`.trim();
}

export function buildGroupsRequestXml(companyName: string): string {
  return `<ENVELOPE>
<HEADER>
<VERSION>1</VERSION>
<TALLYREQUEST>Export</TALLYREQUEST>
<TYPE>Collection</TYPE>
<ID>List of Groups</ID>
</HEADER>
<BODY>
<DESC>
<STATICVARIABLES>
<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${escapeXml(companyName)}</SVCURRENTCOMPANY>
</STATICVARIABLES>
</DESC>
</BODY>
</ENVELOPE>`.trim();
}

export function buildVoucherTypesRequestXml(companyName: string): string {
  return `<ENVELOPE>
<HEADER>
<VERSION>1</VERSION>
<TALLYREQUEST>Export</TALLYREQUEST>
<TYPE>Collection</TYPE>
<ID>List of Voucher Types</ID>
</HEADER>
<BODY>
<DESC>
<STATICVARIABLES>
<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${escapeXml(companyName)}</SVCURRENTCOMPANY>
</STATICVARIABLES>
</DESC>
</BODY>
</ENVELOPE>`.trim();
}

export function buildCreateVoucherXml(
  companyName: string,
  voucherXmlBody: string
): string {
  return `<ENVELOPE>
<HEADER>
<VERSION>1</VERSION>
<TALLYREQUEST>Import</TALLYREQUEST>
<TYPE>Data</TYPE>
<ID>Vouchers</ID>
</HEADER>
<BODY>
<DESC>
<STATICVARIABLES>
<SVCURRENTCOMPANY>${escapeXml(companyName)}</SVCURRENTCOMPANY>
</STATICVARIABLES>
</DESC>
<DATA>
<TALLYMESSAGE xmlns:UDF="TallyUDF">
${voucherXmlBody}
</TALLYMESSAGE>
</DATA>
</BODY>
</ENVELOPE>`.trim();
}

// ═══════════════════════════════════════════════════════════════════
// XML → tallymessage JSON CONVERTERS
// ═══════════════════════════════════════════════════════════════════

export function stockItemsXmlToTallyJson(parsed: any): { tallymessage: any[] } {
  const messages: any[] = [];
  const root = extractCollection(parsed);
  const items = findArrayInRoot(root, "STOCKITEM", "STOCK ITEM");

  console.log(`[convert] stockItems: found ${items.length} items`);

  for (const item of items) {
    messages.push({
      metadata: {
        type: "Stock Item",
        name: item["@_NAME"] || item.NAME || "",
      },
      name: item["@_NAME"] || item.NAME || "",
      parent: item.PARENT || "Ungrouped",
      baseunits: item.BASEUNITS || "PC",
      additionalunits: item.ADDITIONALUNITS || " Not Applicable",
      denominator: item.DENOMINATOR || "1",
      openingbalance: item.OPENINGBALANCE || "0",
      openingrate: item.OPENINGRATE || "0",
      openingvalue: item.OPENINGVALUE || 0,
      category: item.CATEGORY || "",
      gstapplicable: item.GSTAPPLICABLE || "",
      gsttypeofsupply: item.GSTTYPEOFSUPPLY || "",
      costingmethod: item.COSTINGMETHOD || "",
      valuationmethod: item.VALUATIONMETHOD || "",
      isbatchwiseon: parseBool(item.ISBATCHWISEON),
      iscostcentreson: parseBool(item.ISCOSTCENTRESON),
      gstdetails: findEntries(item, "GSTDETAILS").map((g: any) => ({
        ...g,
        statewisedetails: findEntries(g, "STATEWISEDETAILS").map((s: any) => ({
          ...s,
          ratedetails: findEntries(s, "RATEDETAILS").map((r: any) => ({
            gstratedutyhead: r.GSTRATEDUTYHEAD || "",
            gstrate: r.GSTRATE || 0,
          })),
        })),
      })),
      hsndetails: findEntries(item, "HSNDETAILS").map((h: any) => ({
        hsncode: h.HSNCODE || h.DESCRIPTION || "",
      })),
      guid: item.GUID || "",
      isdeleted: parseBool(item.ISDELETED),
    });
  }
  return { tallymessage: messages };
}

export function ledgersXmlToTallyJson(parsed: any): { tallymessage: any[] } {
  const messages: any[] = [];
  const root = extractCollection(parsed);
  const ledgers = findArrayInRoot(root, "LEDGER");

  console.log(`[convert] ledgers: found ${ledgers.length} ledgers`);

  for (const led of ledgers) {
    messages.push({
      metadata: {
        type: "Ledger",
        name: led["@_NAME"] || led.NAME || "",
      },
      name: led["@_NAME"] || led.NAME || "",
      parent: led.PARENT || "Unsorted",
      openingbalance: led.OPENINGBALANCE || 0,
      gstin: led.PARTYGSTIN || led.GSTIN || led["LEDGERGSTIN"] || "",
      creditperiod: led.CREDITPERIOD || led.BILLCREDITPERIOD || "",
      creditdays: led.CREDITDAYS || 0,
      guid: led.GUID || "",
      mailingname: led.MAILINGNAME || "",
      address: led.ADDRESS || "",
      statename: led.STATENAME || led.LEDSTATENAME || "",
      countryname: led.COUNTRYNAME || "",
      pincode: led.PINCODE || "",
      email: led.EMAIL || "",
      phone: led.PHONE || led.LEDGERPHONE || "",
    });
  }
  return { tallymessage: messages };
}

export function vouchersXmlToTallyJson(parsed: any): { tallymessage: any[] } {
  const messages: any[] = [];
  const root = extractCollection(parsed);
  const vouchers = findArrayInRoot(root, "VOUCHER");

  console.log(`[convert] vouchers: found ${vouchers.length} vouchers`);

  for (const v of vouchers) {
    const allLedgerEntries = findEntries(v, "ALLLEDGERENTRIES", "LEDGERENTRIES");
    const allInventoryEntries = findEntries(v, "ALLINVENTORYENTRIES", "INVENTORYENTRIES");

    const ledgerentries = allLedgerEntries.map((le: any) => ({
      ledgername: le.LEDGERNAME || "",
      isdeemedpositive: parseBool(le.ISDEEMEDPOSITIVE),
      ispartyledger: parseBool(le.ISPARTYLEDGER),
      amount: le.AMOUNT || "0",
      billallocations: findEntries(le, "BILLALLOCATIONS").map((ba: any) => ({
        name: ba.NAME || "",
        billtype: ba.BILLTYPE || "New Ref",
        amount: ba.AMOUNT || "0",
        duedate: ba.BILLCREDITPERIOD || "",
      })),
    }));

    const inventoryentries = allInventoryEntries.map((ie: any) => ({
      stockitemname: ie.STOCKITEMNAME || "",
      actualqty: ie.ACTUALQTY || ie.BILLEDQTY || "0",
      billedqty: ie.BILLEDQTY || ie.ACTUALQTY || "0",
      rate: ie.RATE || "0",
      amount: ie.AMOUNT || "0",
      isdeemedpositive: parseBool(ie.ISDEEMEDPOSITIVE),
    }));

    messages.push({
      metadata: { type: "Voucher" },
      date: v.DATE || "",
      guid: v.GUID || v["@_GUID"] || "",
      vouchernumber: v.VOUCHERNUMBER || v.REFERENCE || "",
      vouchertypename: v.VOUCHERTYPENAME || "",
      partyledgername: v.PARTYLEDGERNAME || "",
      narration: v.NARRATION || "",
      reference: v.REFERENCE || "",
      iscancelled: parseBool(v.ISCANCELLED),
      isoptional: parseBool(v.ISOPTIONAL),
      isdeleted: parseBool(v.ISDELETED),
      isinvoice: parseBool(v.ISINVOICE),
      effectivedate: v.EFFECTIVEDATE || v.DATE || "",
      allledgerentries: ledgerentries,
      ledgerentries: ledgerentries,
      allinventoryentries: inventoryentries,
      inventoryentries: inventoryentries,
    });
  }
  return { tallymessage: messages };
}

export function companyXmlToTallyJson(parsed: any): any {
  const root = extractCollection(parsed);
  const companies = findArrayInRoot(root, "COMPANY");

  console.log(`[convert] companies: found ${companies.length}`);

  if (companies.length === 0) return null;

  const c = companies[0];
  return {
    name: c["@_NAME"] || c.NAME || c.COMPANYNAME || "",
    gstin: c.GSTIN || "",
    fystart: c.STARTINGFROM ? parseInt(String(c.STARTINGFROM).slice(4, 6)) : 4,
    startDate: c.STARTINGFROM || "",
    endDate: c.ENDINGAT || c.BOOKSTO || "",
  };
}

// ═══════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════

function ensureArray(v: any): any[] {
  if (Array.isArray(v)) return v;
  if (v && typeof v === "object") return [v];
  return [];
}

function parseBool(v: any): boolean {
  if (typeof v === "boolean") return v;
  const s = String(v || "").toLowerCase().trim();
  return s === "yes" || s === "true" || s === "1";
}

/**
 * Navigate parsed XML to find the data root.
 * Tally Collection export response structure can be:
 *   ENVELOPE > BODY > DATA > TALLYMESSAGE > [STOCKITEM, LEDGER, VOUCHER...]
 *   ENVELOPE > BODY > DATA > COLLECTION > [...]
 *   ENVELOPE > BODY > COLLECTION > [...]
 * This function returns the object containing the entity arrays.
 */
function extractCollection(parsed: any): any {
  // Try ALL known Tally response paths, most specific first
  const paths = [
    parsed?.ENVELOPE?.BODY?.DATA?.TALLYMESSAGE,    // Collection export (most common)
    parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION,       // Some built-in collections
    parsed?.ENVELOPE?.BODY?.TALLYMESSAGE,           // Alternate structure
    parsed?.ENVELOPE?.BODY?.DATA,                   // Fallback
    parsed?.ENVELOPE?.BODY?.COLLECTION,             // Another variant
    parsed?.ENVELOPE?.BODY,                         // Broadest fallback
    parsed?.COLLECTION,
    parsed?.TALLYMESSAGE,
  ];

  for (const p of paths) {
    if (p && typeof p === "object") {
      // If it's an array (TALLYMESSAGE can be array), take first element that has entity tags
      if (Array.isArray(p)) {
        // Merge all array elements into one object
        const merged: any = {};
        for (const item of p) {
          if (item && typeof item === "object") {
            for (const [k, v] of Object.entries(item)) {
              if (merged[k]) {
                merged[k] = [...ensureArray(merged[k]), ...ensureArray(v)];
              } else {
                merged[k] = v;
              }
            }
          }
        }
        if (Object.keys(merged).length > 0) {
          console.log(`[extract] Found data via array merge, keys: ${Object.keys(merged).join(", ")}`);
          return merged;
        }
      }
      // Check if this object has entity-type keys
      const keys = Object.keys(p);
      const hasEntities = keys.some(k => {
        const upper = k.toUpperCase().replace(/\.LIST$/, "");
        return ["STOCKITEM", "LEDGER", "VOUCHER", "COMPANY", "STOCK ITEM"].includes(upper);
      });
      if (hasEntities) {
        console.log(`[extract] Found data root with keys: ${keys.join(", ")}`);
        return p;
      }
    }
  }

  console.warn(`[extract] Could not find data root in parsed XML! Top keys: ${Object.keys(parsed || {}).join(", ")}`);
  return parsed || {};
}

/**
 * Find entity arrays in the root object, trying multiple tag name variants.
 * Handles: STOCKITEM, STOCKITEM.LIST, "STOCK ITEM", etc.
 */
function findArrayInRoot(root: any, ...tagNames: string[]): any[] {
  for (const tag of tagNames) {
    // Try exact match, .LIST suffix, and case variations
    const variants = [
      tag,
      `${tag}.LIST`,
      tag.toUpperCase(),
      `${tag.toUpperCase()}.LIST`,
    ];
    for (const variant of variants) {
      const val = root?.[variant];
      if (val) {
        const arr = ensureArray(val);
        if (arr.length > 0) return arr;
      }
    }
  }
  return [];
}

/**
 * Find child entry arrays in a parent object (e.g., ledger entries within a voucher).
 * Tries key, key.LIST, and case variants.
 */
function findEntries(obj: any, ...keys: string[]): any[] {
  if (!obj) return [];
  for (const key of keys) {
    const variants = [key, `${key}.LIST`, key.toUpperCase(), `${key.toUpperCase()}.LIST`];
    for (const variant of variants) {
      const val = obj[variant];
      if (val !== undefined && val !== null && val !== "") {
        return ensureArray(val);
      }
    }
  }
  return [];
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
