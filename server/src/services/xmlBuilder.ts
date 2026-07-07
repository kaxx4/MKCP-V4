import type { CollectionDef } from "../types.js";

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** YYYYMMDD → D-Mon-YYYY (e.g., "20250401" → "1-Apr-2025") */
export function toTallyDate(yyyymmdd: string): string {
  const y = yyyymmdd.slice(0, 4);
  const m = parseInt(yyyymmdd.slice(4, 6), 10);
  const d = parseInt(yyyymmdd.slice(6, 8), 10);
  return `${d}-${MONTH_NAMES[m - 1]}-${y}`;
}

/**
 * Single generic function that builds Collection-type XML from any CollectionDef.
 * For transaction collections (vouchers), uses the reliable TDL date filter approach.
 * For master collections, uses standard Collection export.
 */
export function buildCollectionXml(
  def: CollectionDef,
  company: string,
  fromDate?: string,
  toDate?: string
): string {
  const colId = `MKCP_${def.tallyCollection}`;

  const fetchLines = def.fetch?.map(f => `<NATIVEMETHOD>${esc(f)}</NATIVEMETHOD>`).join("\n") ?? "";

  let filterBlock = "";
  let filterSystemBlock = "";

  if (def.category === "transaction" && fromDate && toDate) {
    const fromInt = parseInt(fromDate, 10);
    const toInt = parseInt(toDate, 10);
    filterBlock = `<FILTER>MKCPDateFilter</FILTER>`;
    filterSystemBlock = `<SYSTEM TYPE="Formulae" NAME="MKCPDateFilter">($$YearOfDate:$Date * 10000 + $$MonthOfDate:$Date * 100 + $$DayOfDate:$Date) &gt;= ${fromInt} AND ($$YearOfDate:$Date * 10000 + $$MonthOfDate:$Date * 100 + $$DayOfDate:$Date) &lt;= ${toInt}</SYSTEM>`;
  }

  return `<ENVELOPE>
<HEADER>
<VERSION>1</VERSION>
<TALLYREQUEST>Export</TALLYREQUEST>
<TYPE>Collection</TYPE>
<ID>${colId}</ID>
</HEADER>
<BODY>
<DESC>
<STATICVARIABLES>
<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY>
</STATICVARIABLES>
<TDL>
<TDLMESSAGE>
<COLLECTION NAME="${colId}" ISMODIFY="No">
<TYPE>${def.tallyCollection}</TYPE>
${fetchLines}
${filterBlock}
</COLLECTION>
${filterSystemBlock}
</TDLMESSAGE>
</TDL>
</DESC>
</BODY>
</ENVELOPE>`;
}

/**
 * Voucher collection filtered by AlterID — returns every voucher whose alteration
 * id is greater than `sinceAlterId`, with NO date filter. This is how we catch
 * edits to OLD vouchers (outside the daybook date window): any voucher touched in
 * Tally gets a fresh, higher AlterID, so `$AlterID > watermark` surfaces exactly
 * the changed set regardless of date. Same fetch fields as the normal voucher
 * collection so the converter produces identical rows.
 */
export function buildChangedVoucherXml(
  def: CollectionDef,
  company: string,
  sinceAlterId: number
): string {
  const colId = `MKCP_Changed_${def.tallyCollection}`;
  const fetchLines = def.fetch?.map(f => `<NATIVEMETHOD>${esc(f)}</NATIVEMETHOD>`).join("\n") ?? "";
  const since = Math.max(0, Math.floor(sinceAlterId || 0));
  return `<ENVELOPE>
<HEADER>
<VERSION>1</VERSION>
<TALLYREQUEST>Export</TALLYREQUEST>
<TYPE>Collection</TYPE>
<ID>${colId}</ID>
</HEADER>
<BODY>
<DESC>
<STATICVARIABLES>
<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY>
</STATICVARIABLES>
<TDL>
<TDLMESSAGE>
<COLLECTION NAME="${colId}" ISMODIFY="No">
<TYPE>${def.tallyCollection}</TYPE>
${fetchLines}
<FILTER>MKCPAlterFilter</FILTER>
</COLLECTION>
<SYSTEM TYPE="Formulae" NAME="MKCPAlterFilter">$AlterID &gt; ${since}</SYSTEM>
</TDLMESSAGE>
</TDL>
</DESC>
</BODY>
</ENVELOPE>`;
}

/** Lightweight: fetch AltMstId + AltVchId from Company object */
export function buildAlterIdXml(company: string): string {
  return `<ENVELOPE>
<HEADER>
<VERSION>1</VERSION>
<TALLYREQUEST>Export</TALLYREQUEST>
<TYPE>Collection</TYPE>
<ID>MKCPAlterIds</ID>
</HEADER>
<BODY>
<DESC>
<STATICVARIABLES>
<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY>
</STATICVARIABLES>
<TDL>
<TDLMESSAGE>
<COLLECTION NAME="MKCPAlterIds" ISMODIFY="No">
<TYPE>Company</TYPE>
<NATIVEMETHOD>Name</NATIVEMETHOD>
<NATIVEMETHOD>AltMstId</NATIVEMETHOD>
<NATIVEMETHOD>AltVchId</NATIVEMETHOD>
</COLLECTION>
</TDLMESSAGE>
</TDL>
</DESC>
</BODY>
</ENVELOPE>`;
}

/** Aggregation: get per-date voucher counts — used for smart batching */
export function buildVoucherCountXml(company: string, fromDate: string, toDate: string): string {
  const fromInt = parseInt(fromDate, 10);
  const toInt = parseInt(toDate, 10);
  return `<ENVELOPE>
<HEADER>
<VERSION>1</VERSION>
<TALLYREQUEST>Export</TALLYREQUEST>
<TYPE>Collection</TYPE>
<ID>MKCPVoucherCounts</ID>
</HEADER>
<BODY>
<DESC>
<STATICVARIABLES>
<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY>
</STATICVARIABLES>
<TDL>
<TDLMESSAGE>
<COLLECTION NAME="MKCPVoucherCounts" ISMODIFY="No">
<TYPE>Voucher</TYPE>
<NATIVEMETHOD>Date</NATIVEMETHOD>
<FILTER>MKCPCountFilter</FILTER>
</COLLECTION>
<SYSTEM TYPE="Formulae" NAME="MKCPCountFilter">($$YearOfDate:$Date * 10000 + $$MonthOfDate:$Date * 100 + $$DayOfDate:$Date) &gt;= ${fromInt} AND ($$YearOfDate:$Date * 10000 + $$MonthOfDate:$Date * 100 + $$DayOfDate:$Date) &lt;= ${toInt}</SYSTEM>
</TDLMESSAGE>
</TDL>
</DESC>
</BODY>
</ENVELOPE>`;
}

/**
 * Day Book fallback XML — used when Collection returns 0 vouchers.
 * Reference: TallyPrime Integration Guide - "Exporting Transactions (Day Book)"
 */
export function buildDayBookXml(company: string, from: string, to: string): string {
  const tallyFrom = toTallyDate(from);
  const tallyTo = toTallyDate(to);
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
