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

import type { CanonicalItem, CanonicalLedger, CompanyInfo, ImportWarning, DealerPrice } from "../types/canonical";

export interface StockGroupInfo {
  name: string;
  parent: string;
  isAddable: boolean;
}

export interface UnitInfo {
  name: string;
  originalName: string;
  baseUnits: string;
  additionalUnits: string;
  conversion: string;
  isSimple: boolean;
  isCompound: boolean;
}

export interface DealerPriceListInfo {
  priceListName: string;
  items: Array<{
    itemName: string;
    itemGuid?: string;
    priceRate: number;
    dealerDiscount?: number;
    barcode?: string;
  }>;
}

export interface MasterParseResult {
  company: CompanyInfo | null;
  items: Map<string, CanonicalItem>;
  ledgers: Map<string, CanonicalLedger>;
  stockGroups: StockGroupInfo[];
  units: UnitInfo[];
  dealerPriceLists: DealerPriceListInfo[];
  warnings: ImportWarning[];
}

export function parseMasters(raw: unknown): MasterParseResult {
  const warnings: ImportWarning[] = [];
  const items = new Map<string, CanonicalItem>();
  const ledgers = new Map<string, CanonicalLedger>();
  const stockGroups: StockGroupInfo[] = [];
  const units: UnitInfo[] = [];
  const dealerPriceLists: DealerPriceListInfo[] = [];
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

  for (const raw_group of normalized.stockGroups ?? []) {
    try {
      const g = tallyRealStockGroupToSimple(raw_group);
      if (g) stockGroups.push(g);
    } catch (e) {
      warnings.push({ severity: "warn", context: `stockGroup:${raw_group?.name}`, message: String(e) });
    }
  }

  for (const raw_unit of normalized.units ?? []) {
    try {
      const u = tallyRealUnitToSimple(raw_unit);
      if (u) units.push(u);
    } catch (e) {
      warnings.push({ severity: "warn", context: `unit:${raw_unit?.name}`, message: String(e) });
    }
  }

  for (const raw_pl of normalized.dealerPriceLists ?? []) {
    try {
      const pl = parseOneDealerPriceList(raw_pl, items, warnings);
      if (pl) dealerPriceLists.push(pl);
    } catch (e) {
      warnings.push({ severity: "warn", context: `priceList:${raw_pl?.name}`, message: String(e) });
    }
  }

  if (stockGroups.length > 0) {
    warnings.push({ severity: "info", context: "parser", message: `Parsed ${stockGroups.length} stock groups` });
  }
  if (units.length > 0) {
    warnings.push({ severity: "info", context: "parser", message: `Parsed ${units.length} units` });
  }
  if (dealerPriceLists.length > 0) {
    warnings.push({ severity: "info", context: "parser", message: `Parsed ${dealerPriceLists.length} dealer price lists` });
  }

  if (items.size === 0 && ledgers.size === 0) {
    warnings.push({ severity: "warn", context: "parser", message: "No items or ledgers found in masters file" });
  }

  return { company, items, ledgers, stockGroups, units, dealerPriceLists, warnings };
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
    const stockGroups: any[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const units: any[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dealerPriceLists: any[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let company: any = null;

    for (const msg of obj.tallymessage) {
      const type = msg?.metadata?.type ?? msg?.metadata?.TYPE;
      if (type === "Stock Item" || type === "STOCKITEM") {
        stockItems.push(tallyRealStockItemToSimple(msg));
      } else if (type === "Ledger" || type === "LEDGER") {
        ledgers.push(tallyRealLedgerToSimple(msg));
      } else if (type === "Stock Group" || type === "STOCKGROUP") {
        stockGroups.push(msg);
      } else if (type === "Unit" || type === "UNIT") {
        units.push(msg);
      } else if (type === "Price List" || type === "PRICELIST") {
        dealerPriceLists.push(msg);
      } else if (type === "Company" || type === "COMPANY") {
        company = msg;
      }
    }

    if (stockItems.length === 0 && ledgers.length === 0) {
      warnings.push({ severity: "warn", context: "parser", message: `tallymessage has ${obj.tallymessage.length} entries but no Stock Items or Ledgers found` });
    }

    return { stockItems, ledgers, stockGroups, units, dealerPriceLists, company };
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

function tallyRealStockGroupToSimple(msg: any): StockGroupInfo | null {
  const name = msg?.metadata?.name ?? msg?.name ?? "";
  if (!name) return null;
  return {
    name: String(name).trim(),
    parent: String(msg?.parent ?? "Primary").trim(),
    isAddable: String(msg?.isaddable ?? "Yes").trim() === "Yes",
  };
}

function tallyRealUnitToSimple(msg: any): UnitInfo | null {
  const name = msg?.metadata?.name ?? msg?.name ?? "";
  if (!name) return null;
  return {
    name: String(name).trim(),
    originalName: String(msg?.originalname ?? name).trim(),
    baseUnits: String(msg?.baseunits ?? "").trim(),
    additionalUnits: String(msg?.additionalunits ?? "").trim(),
    conversion: String(msg?.conversion ?? "").trim(),
    isSimple: String(msg?.issimpleunit ?? "No").trim() === "Yes",
    isCompound: String(msg?.isformallycompound ?? "No").trim() === "Yes",
  };
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

  // Parse closing balance: same format as opening
  const closingBalStr = String(msg?.closingbalance ?? "0").trim();
  const closingQty = parseQtyString(closingBalStr);
  const closingRateStr = String(msg?.closingrate ?? "0").trim();
  const closingRate = parseRateString(closingRateStr);
  const closingValue = Math.abs(parseNumber(msg?.closingvalue ?? 0));

  // Parse denominator (units per pkg): " 4" → 4
  const denomStr = String(msg?.denominator ?? "1").trim();
  const denom = parseNumber(denomStr);

  // Extract parent (group) — keep the full name as it appears in Tally
  const parent = String(msg?.parent ?? "Ungrouped").trim();

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
    category: String(msg?.category ?? "").trim() || undefined,
    baseUnit: String(msg?.baseunits ?? "PC").trim(),
    pkgUnit: hasAddlUnits ? addlUnits : null,
    unitsPerPkg: hasAddlUnits && denom > 0 ? denom : 1,
    openingQty,
    openingValue,
    openingRate,
    closingQty,
    closingValue,
    closingRate,
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
  // Prefer explicit rate if provided, else calculate from value/qty
  const explicitRate = parseNumber(raw.openingRate ?? 0);
  const openingRate = explicitRate > 0
    ? explicitRate
    : (openingQty > 0 ? (openingValue / openingQty) : 0);

  const unitsPerPkg = parseNumber(raw.unitsPerPkg ?? raw.denominator ?? 1);

  // Clean pkg unit - normalize case for "not applicable" check
  let pkgUnit: string | null = null;
  if (raw.pkgUnit) {
    const pu = String(raw.pkgUnit).trim();
    const puLower = pu.toLowerCase();
    if (pu && !puLower.includes("not applicable") && puLower !== "not applicable") {
      pkgUnit = pu.toUpperCase();
    }
  }

  if (!raw.group && !raw.parent) {
    warnings.push({ severity: "info", context: `item:${name}`, message: "No group/parent found" });
  }

  // Parse closing balance fields
  const closingQty = parseNumber(raw.closingQty ?? raw.closingQtyBase ?? 0);
  const closingValueRaw = parseNumber(raw.closingValue ?? 0);
  const explicitClosingRate = parseNumber(raw.closingRate ?? 0);
  const closingRate = explicitClosingRate > 0
    ? explicitClosingRate
    : (closingQty > 0 ? (closingValueRaw / closingQty) : 0);

  return {
    itemId,
    name,
    group: String(raw.group ?? raw.parent ?? "Ungrouped").trim(),
    category: raw.category ? String(raw.category).trim() : undefined,
    baseUnit: String(raw.baseUnit ?? raw.baseUnits ?? "PC").toUpperCase().trim(),
    pkgUnit,
    unitsPerPkg: unitsPerPkg > 0 ? unitsPerPkg : 1,
    openingQtyBase: openingQty,
    openingRate,
    openingValue,
    closingQtyBase: closingQty > 0 ? closingQty : undefined,
    closingRate: closingRate > 0 ? closingRate : undefined,
    // closingValue=0 is valid (item fully sold out) — don't use || which treats 0 as falsy
    closingValue: closingValueRaw,
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseOneDealerPriceList(
  raw: any,
  items: Map<string, CanonicalItem>,
  warnings: ImportWarning[]
): DealerPriceListInfo | null {
  if (!raw?.name && !raw?.metadata?.name) return null;
  const plName = String(raw.metadata?.name ?? raw.name ?? "").trim();
  if (!plName) return null;

  const plItems = (raw.items ?? []).map((item: any) => {
    const itemName = String(item.itemName ?? item.name ?? "").trim();
    const rate = parseNumber(item.priceRate ?? item.rate ?? item.unitRate ?? 0);

    return {
      itemName,
      itemGuid: item.itemGuid ? String(item.itemGuid).trim() : undefined,
      priceRate: rate,
      dealerDiscount: item.dealerDiscount ? parseNumber(item.dealerDiscount) : undefined,
      barcode: item.barcode ? String(item.barcode).trim() : undefined,
    };
  }).filter((i: any) => i.itemName && i.priceRate > 0);

  if (plItems.length === 0) {
    warnings.push({ severity: "warn", context: `priceList:${plName}`, message: "No valid price items found" });
    return null;
  }

  // Attach dealer prices to each item
  for (const plItem of plItems) {
    const itemId = plItem.itemName.toUpperCase();
    const item = items.get(itemId);
    if (item) {
      if (!item.dealerPrices) item.dealerPrices = [];
      item.dealerPrices.push({
        priceListName: plName,
        dealerRate: plItem.priceRate,
        dealerDiscount: plItem.dealerDiscount,
        barcode: plItem.barcode,
      });
    }
  }

  return {
    priceListName: plName,
    items: plItems,
  };
}

/** Parse quantity string like " 240 PC", "9.000 Pcs", "-1234 Nos", "0.500 Kg" → number */
function parseQtyString(s: string): number {
  if (!s) return 0;
  const cleaned = s.trim();
  if (!cleaned) return 0;
  // Match optional leading minus/space, then digits with optional decimal
  const match = cleaned.match(/^(-?\s*\d+(?:\.\d+)?)/);
  if (match) {
    const numStr = match[1].replace(/\s+/g, "");
    const n = parseFloat(numStr);
    return isFinite(n) ? n : 0;
  }
  // Fallback: try extracting any number from the string
  const fallbackMatch = cleaned.match(/(-?\d+(?:\.\d+)?)/);
  if (fallbackMatch) {
    const n = parseFloat(fallbackMatch[1]);
    return isFinite(n) ? n : 0;
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
