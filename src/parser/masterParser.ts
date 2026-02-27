/**
 * Master parser — handles the actual Tally Prime JSON export format.
 *
 * The real format is: { "tallymessage": [...] }
 * Each message has: { "metadata": { "type": "Stock Item" | "Ledger" | ... }, ...fields }
 *
 * Key parsing quirks from real Tally data:
 *  - openingbalance for stock items: " 9 PC" (string with unit)
 *  - openingrate: "2080.00/PC" (string with separator)
 *  - openingvalue: -18720.00 (number, may be negative)
 *  - denominator: " 4" (string with leading space)
 *  - additionalunits: " Not Applicable" or "PKG"
 *  - isdeemedpositive: boolean (not "Yes"/"No" string)
 */

import type { CanonicalItem, CanonicalLedger, CompanyInfo, ImportWarning } from "../types/canonical";

export interface MasterParseResult {
  company: CompanyInfo | null;
  items: Map<string, CanonicalItem>;
  ledgers: Map<string, CanonicalLedger>;
  warnings: ImportWarning[];
}

export function parseMasters(raw: unknown): MasterParseResult {
  const warnings: ImportWarning[] = [];
  const items = new Map<string, CanonicalItem>();
  const ledgers = new Map<string, CanonicalLedger>();
  let company: CompanyInfo | null = null;

  const normalized = normalizeMasterInput(raw, warnings);

  if (normalized.company) {
    company = {
      name: String(normalized.company.name ?? "MK Cycles"),
      gstin: normalized.company.gstin,
      fyStartMonth: Number(normalized.company.fyStartMonth ?? 4),
    };
  }

  for (const raw_item of normalized.stockItems ?? []) {
    try {
      const item = parseOneItem(raw_item, warnings);
      if (item) items.set(item.itemId, item);
    } catch (e) {
      warnings.push({ severity: "warn", context: `item:${raw_item?.name}`, message: String(e) });
    }
  }

  for (const raw_ledger of normalized.ledgers ?? []) {
    try {
      const ledger = parseOneLedger(raw_ledger, warnings);
      if (ledger) ledgers.set(ledger.ledgerId, ledger);
    } catch (e) {
      warnings.push({ severity: "warn", context: `ledger:${raw_ledger?.name}`, message: String(e) });
    }
  }

  if (items.size === 0 && ledgers.size === 0) {
    warnings.push({ severity: "warn", context: "parser", message: "No items or ledgers found in masters file" });
  }

  return { company, items, ledgers, warnings };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeMasterInput(raw: unknown, warnings: ImportWarning[]): any {
  if (!raw || typeof raw !== "object") return {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const obj = raw as Record<string, any>;

  // ── Format 1: Real Tally JSON export { tallymessage: [...] } ──
  if (Array.isArray(obj.tallymessage)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stockItems: any[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ledgers: any[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let company: any = null;

    for (const msg of obj.tallymessage) {
      const type = msg?.metadata?.type ?? msg?.metadata?.TYPE;
      if (type === "Stock Item" || type === "STOCKITEM") {
        stockItems.push(tallyRealStockItemToSimple(msg));
      } else if (type === "Ledger" || type === "LEDGER") {
        ledgers.push(tallyRealLedgerToSimple(msg));
      } else if (type === "Company" || type === "COMPANY") {
        company = msg;
      }
    }

    if (stockItems.length === 0 && ledgers.length === 0) {
      warnings.push({ severity: "warn", context: "parser", message: `tallymessage has ${obj.tallymessage.length} entries but no Stock Items or Ledgers found` });
    }

    return { stockItems, ledgers, company };
  }

  // ── Format 2: Tally ENVELOPE format ──
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const messages = (obj as any)?.ENVELOPE?.BODY?.IMPORTDATA?.REQUESTDATA?.TALLYMESSAGE;
    if (Array.isArray(messages)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stockItems: any[] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ledgersArr: any[] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let company: any = null;
      for (const msg of messages) {
        if (msg.STOCKITEM) stockItems.push(tallyEnvelopeStockItemToSimple(msg.STOCKITEM));
        if (msg.LEDGER) ledgersArr.push(tallyEnvelopeLedgerToSimple(msg.LEDGER));
        if (msg.COMPANY) company = msg.COMPANY;
      }
      return { stockItems, ledgersArr, company };
    }
  } catch { /* ignore */ }

  // ── Format 3: Simple { stockItems: [...], ledgers: [...] } ──
  return obj;
}

/** Convert real Tally JSON stock item to simple form */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function tallyRealStockItemToSimple(msg: any): any {
  const name = msg?.metadata?.name ?? msg?.languagename?.[1] ?? msg?.name ?? "";
  const addlUnits = String(msg?.additionalunits ?? "").trim();
  const hasAddlUnits = addlUnits && !addlUnits.toLowerCase().includes("not applicable") && addlUnits !== "";

  // Parse opening balance: " 9 PC" → 9, " 240 PC" → 240
  const openingBalStr = String(msg?.openingbalance ?? "0").trim();
  const openingQty = parseQtyString(openingBalStr);

  // Parse opening rate: "2080.00/PC" → 2080.00
  const openingRateStr = String(msg?.openingrate ?? "0").trim();
  const openingRate = parseRateString(openingRateStr);

  // Parse opening value (may be negative in Tally = debit)
  const openingValue = Math.abs(parseNumber(msg?.openingvalue ?? 0));

  // Parse denominator (units per pkg): " 4" → 4
  const denomStr = String(msg?.denominator ?? "1").trim();
  const denom = parseNumber(denomStr);

  // Extract parent (group) — may contain HSN info like "TRICYCLE DASH ( 950300 @ 12/ 5 %)"
  let parent = String(msg?.parent ?? "Ungrouped").trim();
  // Clean up: remove HSN suffix in parentheses at end
  parent = parent.replace(/\s*\([^)]*\)\s*$/, "").trim() || parent;

  // GST rate from gstdetails
  let gstRate: number | undefined;
  const gstDetails = msg?.gstdetails;
  if (Array.isArray(gstDetails) && gstDetails.length > 0) {
    const latest = gstDetails[gstDetails.length - 1];
    const rates = latest?.statewisedetails?.[0]?.ratedetails ?? [];
    for (const rd of rates) {
      if (rd.gstratedutyhead === "IGST" && rd.gstrate) {
        gstRate = parseNumber(rd.gstrate);
        break;
      }
    }
  }

  // HSN from hsndetails
  let hsn: string | undefined;
  const hsnDetails = msg?.hsndetails;
  if (Array.isArray(hsnDetails) && hsnDetails.length > 0) {
    hsn = String(hsnDetails[0]?.hsncode ?? "").trim() || undefined;
  }

  return {
    name,
    group: parent,
    baseUnit: String(msg?.baseunits ?? "PC").trim(),
    pkgUnit: hasAddlUnits ? addlUnits : null,
    unitsPerPkg: hasAddlUnits && denom > 0 ? denom : 1,
    openingQty,
    openingValue,
    openingRate,
    hsn,
    gstRate,
  };
}

/** Convert real Tally JSON ledger to simple form */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function tallyRealLedgerToSimple(msg: any): any {
  const name = msg?.metadata?.name ?? msg?.name ?? "";
  const parent = String(msg?.parent ?? "Unsorted").trim();
  const openingBalance = parseNumber(msg?.openingbalance ?? 0);
  // creditperiod: "20 Days" → 20
  const creditPeriod = msg?.creditperiod ? parseCreditDays(String(msg.creditperiod)) : 0;

  return {
    name,
    group: parent,
    openingBalance,
    gstin: msg?.gstin ? String(msg.gstin).trim() : undefined,
    creditDays: creditPeriod,
  };
}

/** Parse Tally ENVELOPE format stock item */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function tallyEnvelopeStockItemToSimple(t: any): any {
  return {
    name: t.NAME ?? t["@NAME"],
    group: t.PARENT,
    baseUnit: t.BASEUNITS,
    pkgUnit: t.ADDITIONALUNITS ?? null,
    unitsPerPkg: t.DENOMINATOR ? Number(t.DENOMINATOR) : 1,
    openingQty: parseNumber(t.OPENINGBALANCE),
    openingValue: parseNumber(t.OPENINGVALUE),
    openingRate: parseNumber(t.OPENINGRATE),
    hsn: t.HSNDETAILS?.[0]?.HSNCODE,
  };
}

/** Parse Tally ENVELOPE format ledger */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function tallyEnvelopeLedgerToSimple(t: any): any {
  return {
    name: t.NAME ?? t["@NAME"],
    group: t.PARENT,
    openingBalance: parseNumber(t.OPENINGBALANCE),
    gstin: t.GSTIN,
    creditDays: parseNumber(t.CREDITPERIOD ?? "0"),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseOneItem(raw: any, warnings: ImportWarning[]): CanonicalItem | null {
  if (!raw?.name) return null;
  const name = String(raw.name).trim();
  if (!name) return null;
  const itemId = name.toUpperCase();

  const openingQty = parseNumber(raw.openingQty ?? raw.openingQtyBase ?? 0);
  const openingValue = parseNumber(raw.openingValue ?? 0);
  const openingRate = openingQty > 0
    ? (parseNumber(raw.openingRate ?? 0) || (openingValue / openingQty))
    : 0;

  const unitsPerPkg = parseNumber(raw.unitsPerPkg ?? raw.denominator ?? 1);

  // Clean pkg unit
  let pkgUnit: string | null = null;
  if (raw.pkgUnit) {
    const pu = String(raw.pkgUnit).trim();
    if (pu && !pu.toLowerCase().includes("not applicable")) {
      pkgUnit = pu.toUpperCase();
    }
  }

  if (!raw.group && !raw.parent) {
    warnings.push({ severity: "info", context: `item:${name}`, message: "No group/parent found" });
  }

  return {
    itemId,
    name,
    group: String(raw.group ?? raw.parent ?? "Ungrouped").trim(),
    baseUnit: String(raw.baseUnit ?? raw.baseUnits ?? "PC").toUpperCase().trim(),
    pkgUnit,
    unitsPerPkg: unitsPerPkg > 0 ? unitsPerPkg : 1,
    openingQtyBase: openingQty,
    openingRate,
    openingValue,
    hsn: raw.hsn ? String(raw.hsn) : undefined,
    gstRate: raw.gstRate ? Number(raw.gstRate) : undefined,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseOneLedger(raw: any, _warnings: ImportWarning[]): CanonicalLedger | null {
  if (!raw?.name) return null;
  const name = String(raw.name).trim();
  if (!name) return null;
  return {
    ledgerId: name.toUpperCase(),
    name,
    group: String(raw.group ?? raw.parent ?? "Unsorted").trim(),
    openingBalance: parseNumber(raw.openingBalance ?? 0),
    gstin: raw.gstin ? String(raw.gstin) : undefined,
    creditDays: parseNumber(raw.creditDays ?? raw.creditPeriod ?? raw.creditperiod ?? 0),
  };
}

/** Parse quantity string like " 240 PC" → 240 */
function parseQtyString(s: string): number {
  if (!s) return 0;
  // Extract first number from string
  const match = s.match(/^[\s-]*([0-9]+(?:\.[0-9]+)?)/);
  if (match) {
    const n = parseFloat(match[1]);
    return s.trim().startsWith("-") ? -n : n;
  }
  return parseNumber(s);
}

/** Parse rate string like "2080.00/PC" or "185.71/PR" → number */
function parseRateString(s: string): number {
  if (!s) return 0;
  // Take everything before the "/" if present
  const parts = s.split("/");
  return parseNumber(parts[0]);
}

/** Parse credit period like "20 Days" → 20 */
function parseCreditDays(s: string): number {
  const match = s.match(/(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

function parseNumber(v: unknown): number {
  if (v === null || v === undefined || v === "") return 0;
  const s = String(v).replace(/[^0-9.\-]/g, "");
  const n = Number(s);
  return isFinite(n) ? n : 0;
}
