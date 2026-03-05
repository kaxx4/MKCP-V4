import { XMLParser, XMLBuilder } from "fast-xml-parser";
import axios from "axios";

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  isArray: (name) => {
    // These tags should ALWAYS be arrays even when single item
    const arrayTags = [
      "LEDGER", "STOCKITEM", "VOUCHER", "COMPANY",
      "LEDGERENTRY", "ALLLEDGERENTRIES", "ALLINVENTORYENTRIES",
      "INVENTORYENTRIES", "LEDGERENTRIES",
      "GSTDETAILS", "HSNDETAILS", "STATEDETAILS",
      "RATEDETAILS", "STATEWISEDETAILS",
      "BATCHALLOCATIONS", "CATEGORYALLOCATIONS",
      "BILLALLOCATIONS",
    ];
    return arrayTags.includes(name.toUpperCase());
  },
  parseTagValue: true,
  trimValues: true,
});

/**
 * Send raw XML to Tally and get parsed JSON back
 */
export async function postToTally(tallyUrl: string, xml: string): Promise<any> {
  const response = await axios.post(tallyUrl, xml, {
    headers: { "Content-Type": "text/xml; charset=utf-8" },
    timeout: 120000, // 2 min – large companies can be slow
    responseType: "text",
  });
  return xmlParser.parse(response.data);
}

// ═══════════════════════════════════════════════════════════════════
// XML REQUEST BUILDERS – one for each data type we need
// ═══════════════════════════════════════════════════════════════════

/**
 * Fetch active company info
 */
export function buildCompanyRequestXml(): string {
  return `<ENVELOPE>
<HEADER>
<VERSION>1</VERSION>
<TALLYREQUEST>Export</TALLYREQUEST>
<TYPE>Data</TYPE>
<ID>CompanyInfo</ID>
</HEADER>
<BODY>
<DESC>
<STATICVARIABLES>
<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
</STATICVARIABLES>
<TDL>
<TDLMESSAGE>
<REPORT NAME="CompanyInfo">
<FORMS>CompanyInfo</FORMS>
</REPORT>
<FORM NAME="CompanyInfo">
<PARTS>CompanyInfoPart</PARTS>
</FORM>
<PART NAME="CompanyInfoPart">
<TOPPARTS>CompanyInfoPart</TOPPARTS>
<REPEAT>CompanyInfoPart : CompanyCollection</REPEAT>
<SCROLLED>Vertical</SCROLLED>
</PART>
<PART NAME="CompanyInfoPart">
<LINES>CompanyName, CompanyGSTIN, CompanyStartDate, CompanyEndDate</LINES>
</PART>
<LINE NAME="CompanyName">
<FIELD>CompanyNameFld</FIELD>
</LINE>
<LINE NAME="CompanyGSTIN">
<FIELD>CompanyGSTINFld</FIELD>
</LINE>
<LINE NAME="CompanyStartDate">
<FIELD>CompanyStartDateFld</FIELD>
</LINE>
<LINE NAME="CompanyEndDate">
<FIELD>CompanyEndDateFld</FIELD>
</LINE>
<FIELD NAME="CompanyNameFld">
<SET>$$Name</SET>
</FIELD>
<FIELD NAME="CompanyGSTINFld">
<SET>$$GSTIN</SET>
</FIELD>
<FIELD NAME="CompanyStartDateFld">
<SET>$$StartingFrom</SET>
</FIELD>
<FIELD NAME="CompanyEndDateFld">
<SET>$$EndingAt</SET>
</FIELD>
<COLLECTION NAME="CompanyCollection">
<TYPE>Company</TYPE>
</COLLECTION>
</TDLMESSAGE>
</TDL>
</DESC>
</BODY>
</ENVELOPE>`.trim();
}

/**
 * Fetch ALL stock items with full details (opening bal, units, GST, HSN)
 */
export function buildStockItemsRequestXml(companyName: string): string {
  return `<ENVELOPE>
<HEADER>
<VERSION>1</VERSION>
<TALLYREQUEST>Export</TALLYREQUEST>
<TYPE>Collection</TYPE>
<ID>AllStockItems</ID>
</HEADER>
<BODY>
<DESC>
<STATICVARIABLES>
<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${escapeXml(companyName)}</SVCURRENTCOMPANY>
</STATICVARIABLES>
<TDL>
<TDLMESSAGE>
<COLLECTION NAME="AllStockItems">
<TYPE>Stock Item</TYPE>
<FETCH>*</FETCH>
</COLLECTION>
</TDLMESSAGE>
</TDL>
</DESC>
</BODY>
</ENVELOPE>`.trim();
}

/**
 * Fetch ALL ledgers with full details
 */
export function buildLedgersRequestXml(companyName: string): string {
  return `<ENVELOPE>
<HEADER>
<VERSION>1</VERSION>
<TALLYREQUEST>Export</TALLYREQUEST>
<TYPE>Collection</TYPE>
<ID>AllLedgers</ID>
</HEADER>
<BODY>
<DESC>
<STATICVARIABLES>
<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${escapeXml(companyName)}</SVCURRENTCOMPANY>
</STATICVARIABLES>
<TDL>
<TDLMESSAGE>
<COLLECTION NAME="AllLedgers">
<TYPE>Ledger</TYPE>
<FETCH>*</FETCH>
</COLLECTION>
</TDLMESSAGE>
</TDL>
</DESC>
</BODY>
</ENVELOPE>`.trim();
}

/**
 * Fetch ALL vouchers (all types) for a given date range.
 * If no dates passed, fetches entire loaded company period.
 */
export function buildVouchersRequestXml(
  companyName: string,
  fromDate?: string,  // YYYYMMDD
  toDate?: string     // YYYYMMDD
): string {
  const dateFilter = fromDate && toDate ? `
<SVFROMDATE>${fromDate}</SVFROMDATE>
<SVTODATE>${toDate}</SVTODATE>` : "";

  return `<ENVELOPE>
<HEADER>
<VERSION>1</VERSION>
<TALLYREQUEST>Export</TALLYREQUEST>
<TYPE>Collection</TYPE>
<ID>AllVouchers</ID>
</HEADER>
<BODY>
<DESC>
<STATICVARIABLES>
<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${escapeXml(companyName)}</SVCURRENTCOMPANY>${dateFilter}
</STATICVARIABLES>
<TDL>
<TDLMESSAGE>
<COLLECTION NAME="AllVouchers">
<TYPE>Voucher</TYPE>
<FETCH>*</FETCH>
</COLLECTION>
</TDLMESSAGE>
</TDL>
</DESC>
</BODY>
</ENVELOPE>`.trim();
}

/**
 * Fetch specific voucher types only (e.g., just Sales or just Purchase)
 */
export function buildVouchersByTypeXml(
  companyName: string,
  voucherType: string,
  fromDate?: string,
  toDate?: string
): string {
  const dateFilter = fromDate && toDate ? `
        <SVFROMDATE>${fromDate}</SVFROMDATE>
        <SVTODATE>${toDate}</SVTODATE>` : "";

  return `
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>MKCP_TypedVouchers</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
        <SVCURRENTCOMPANY>${escapeXml(companyName)}</SVCURRENTCOMPANY>${dateFilter}
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="MKCP_TypedVouchers" ISMODIFY="No" ISFIXED="No" ISINITIALIZE="No" ISOPTION="No" ISINTERNAL="No">
            <TYPE>Voucher</TYPE>
            <NATIVEMETHOD>*</NATIVEMETHOD>
            <FILTERS>MKCP_VchTypeFilter</FILTERS>
          </COLLECTION>
          <SYSTEM TYPE="Formulae" NAME="MKCP_VchTypeFilter">
            $VoucherTypeName = "${escapeXml(voucherType)}"
          </SYSTEM>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`.trim();
}

/**
 * Fetch stock groups
 */
export function buildStockGroupsRequestXml(companyName: string): string {
  return `
<ENVELOPE>
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

/**
 * Fetch ledger groups
 */
export function buildGroupsRequestXml(companyName: string): string {
  return `
<ENVELOPE>
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

/**
 * Fetch voucher types configured in Tally
 */
export function buildVoucherTypesRequestXml(companyName: string): string {
  return `
<ENVELOPE>
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

/**
 * Push/create a voucher into Tally (for future use – order → invoice)
 */
export function buildCreateVoucherXml(
  companyName: string,
  voucherXmlBody: string
): string {
  return `
<ENVELOPE>
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
// These convert Tally's XML response into the EXACT JSON format
// that masterParser.ts and transactionParser.ts already consume.
// ═══════════════════════════════════════════════════════════════════

/**
 * Convert stock items XML response → { tallymessage: [...] } format.
 * Each item becomes a message with metadata.type = "Stock Item"
 */
export function stockItemsXmlToTallyJson(parsed: any): { tallymessage: any[] } {
  const messages: any[] = [];
  const collection = extractCollection(parsed);
  const items = ensureArray(collection?.STOCKITEM || collection?.["STOCK ITEM"] || []);

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
      gstdetails: ensureArray(item.GSTDETAILS || item["GSTDETAILS.LIST"] || []).map((g: any) => ({
        ...g,
        statewisedetails: ensureArray(g.STATEWISEDETAILS || g["STATEWISEDETAILS.LIST"] || []).map((s: any) => ({
          ...s,
          ratedetails: ensureArray(s.RATEDETAILS || s["RATEDETAILS.LIST"] || []).map((r: any) => ({
            gstratedutyhead: r.GSTRATEDUTYHEAD || "",
            gstrate: r.GSTRATE || 0,
          })),
        })),
      })),
      hsndetails: ensureArray(item.HSNDETAILS || item["HSNDETAILS.LIST"] || []).map((h: any) => ({
        hsncode: h.HSNCODE || h.DESCRIPTION || "",
      })),
      guid: item.GUID || "",
      isdeleted: parseBool(item.ISDELETED),
    });
  }
  return { tallymessage: messages };
}

/**
 * Convert ledgers XML response → { tallymessage: [...] } format.
 */
export function ledgersXmlToTallyJson(parsed: any): { tallymessage: any[] } {
  const messages: any[] = [];
  const collection = extractCollection(parsed);
  const ledgers = ensureArray(collection?.LEDGER || []);

  for (const led of ledgers) {
    messages.push({
      metadata: {
        type: "Ledger",
        name: led["@_NAME"] || led.NAME || "",
      },
      name: led["@_NAME"] || led.NAME || "",
      parent: led.PARENT || "Unsorted",
      openingbalance: led.OPENINGBALANCE || 0,
      gstin: led.PARTYGSTIN || led.GSTIN || "",
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

/**
 * Convert vouchers XML response → { tallymessage: [...] } format.
 * This must carefully map ALL voucher fields so transactionParser.ts works.
 */
export function vouchersXmlToTallyJson(parsed: any): { tallymessage: any[] } {
  const messages: any[] = [];
  const collection = extractCollection(parsed);
  const vouchers = ensureArray(collection?.VOUCHER || []);

  for (const v of vouchers) {
    const allLedgerEntries = ensureArray(
      v["ALLLEDGERENTRIES.LIST"] || v.ALLLEDGERENTRIES ||
      v["LEDGERENTRIES.LIST"] || v.LEDGERENTRIES || []
    );

    const allInventoryEntries = ensureArray(
      v["ALLINVENTORYENTRIES.LIST"] || v.ALLINVENTORYENTRIES ||
      v["INVENTORYENTRIES.LIST"] || v.INVENTORYENTRIES || []
    );

    // Map ledger entries
    const ledgerentries = allLedgerEntries.map((le: any) => ({
      ledgername: le.LEDGERNAME || "",
      isdeemedpositive: parseBool(le.ISDEEMEDPOSITIVE),
      ispartyledger: parseBool(le.ISPARTYLEDGER),
      amount: le.AMOUNT || "0",
      billallocations: ensureArray(le["BILLALLOCATIONS.LIST"] || le.BILLALLOCATIONS || []).map((ba: any) => ({
        name: ba.NAME || "",
        billtype: ba.BILLTYPE || "New Ref",
        amount: ba.AMOUNT || "0",
        duedate: ba.BILLCREDITPERIOD || "",
      })),
    }));

    // Map inventory entries
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

/**
 * Convert company XML response
 */
export function companyXmlToTallyJson(parsed: any): any {
  const body = parsed?.ENVELOPE?.BODY;
  const data = body?.DATA || body;
  const companies = ensureArray(
    data?.COLLECTION?.COMPANY || data?.COMPANY || []
  );
  if (companies.length === 0) return null;

  const c = companies[0];
  return {
    name: c["@_NAME"] || c.NAME || c.COMPANYNAME || "",
    gstin: c.GSTIN || c.PARTYLEDGERNAME || "",
    fystart: c.STARTINGFROM ? parseInt(c.STARTINGFROM.slice(4, 6)) : 4,
    startDate: c.STARTINGFROM || "",
    endDate: c.ENDINGAT || "",
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

function extractCollection(parsed: any): any {
  // Tally wraps response: ENVELOPE > BODY > DATA > COLLECTION > TYPE[]
  return (
    parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION ||
    parsed?.ENVELOPE?.BODY?.DATA ||
    parsed?.ENVELOPE?.BODY?.COLLECTION ||
    parsed?.ENVELOPE?.BODY ||
    parsed?.COLLECTION ||
    parsed || {}
  );
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
