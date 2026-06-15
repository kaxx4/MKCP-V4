import { TallyPriceEntry } from "../store/tallyPriceListStore";

/** Parses "799.11/PC" → { value: 799.11, unit: "PC" } */
function parseRateString(s: string): { value: number; unit: string } | null {
  if (!s) return null;
  const slash = s.lastIndexOf("/");
  const valStr = slash === -1 ? s : s.slice(0, slash);
  const unit = slash === -1 ? "PC" : s.slice(slash + 1).trim();
  const value = parseFloat(valStr.replace(/,/g, ""));
  if (isNaN(value)) return null;
  return { value, unit };
}

/** Pick first non-empty string from a list of candidates (case-insensitive key lookup). */
function pick(obj: any, ...keys: string[]): string {
  if (!obj || typeof obj !== "object") return "";
  for (const k of keys) {
    // try exact key first, then uppercase, then lowercase
    const v = obj[k] ?? obj[k.toUpperCase()] ?? obj[k.toLowerCase()];
    if (v != null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

/** Normalize array — handles single object, undefined, or real array. */
function toArr(v: any): any[] {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * Parses the Tally JSON price list export.
 * Handles UTF-16 LE BOM (ÿþ / \uFEFF) automatically.
 *
 * Supports multiple Tally export structures:
 *  A) TALLYMESSAGE.STOCKITEM[].FULLPRICELIST.mpspricelist.PRICELEVELLIST[0].mpsprevrate
 *  B) TALLYMESSAGE.STOCKITEM[].PRICELEVELLIST[0].RATE  (standard Tally export)
 *  C) TALLYMESSAGE.STOCKITEM[] with direct RATE field (simple export)
 */
export function parseTallyPriceListJson(jsonText: string): TallyPriceEntry[] {
  // Strip BOM
  const text = jsonText.replace(/^\uFEFF/, "");

  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error("Invalid JSON: " + (e as Error).message);
  }

  // Support both TALLYMESSAGE (object) and tallymessage (array) roots
  const root = parsed?.TALLYMESSAGE ?? parsed?.tallymessage ?? parsed;

  const stockItems: any[] =
    toArr(root?.STOCKITEM ?? root?.stockitem).filter(Boolean);

  if (stockItems.length === 0) {
    throw new Error("No STOCKITEM entries found in the JSON file.");
  }

  const results: TallyPriceEntry[] = [];

  for (const si of stockItems) {
    // ── Structure A: FULLPRICELIST.mpsstockitemname + PRICELEVELLIST[0].rate ──
    const pl = si?.FULLPRICELIST ?? si?.fullpricelist;
    if (pl) {
      const itemName = pick(pl, "mpsstockitemname", "MPSSTOCKITEMNAME", "stockitemname");
      if (itemName) {
        const pricelist = pl?.mpspricelist ?? pl?.MPSPRICELIST;
        const levels = toArr(pricelist?.PRICELEVELLIST ?? pricelist?.pricelevellist);
        const lvl = levels[0];
        if (lvl) {
          const selling = parseRateString(pick(lvl, "rate", "RATE", "mpsprevrate", "MPSPREVRATE"));
          const cost    = parseRateString(pick(lvl, "mpscostprice", "MPSCOSTPRICE", "COSTPRICE", "costprice"));
          if (selling) {
            results.push({ itemName: itemName.trim(), sellingRate: selling.value, costPrice: cost?.value, unit: selling.unit });
            continue;
          }
        }
      }
    }

    // ── Item name for structures B/C (name on stock item root) ──
    const itemName = pick(si, "NAME", "name", "STOCKITEMNAME");
    if (!itemName) continue;

    // ── Structure B: PRICELEVELLIST directly on stock item ──
    const levels = toArr(si?.PRICELEVELLIST ?? si?.pricelevellist ?? si?.["PRICELEVELLIST.LIST"]);
    if (levels.length > 0) {
      const lvl = levels[0];
      const selling = parseRateString(pick(lvl, "RATE", "rate", "SELLINGRATE", "mpsprevrate"));
      const cost    = parseRateString(pick(lvl, "COSTPRICE", "costprice", "COST", "mpscostprice"));
      if (selling) {
        results.push({ itemName: itemName.trim(), sellingRate: selling.value, costPrice: cost?.value, unit: selling.unit });
        continue;
      }
    }

    // ── Structure C: RATE directly on stock item ──
    const rateStr = pick(si, "RATE", "rate", "SELLINGRATE", "STANDARDRATE", "BASICRATE");
    const selling = parseRateString(rateStr);
    if (selling) {
      results.push({ itemName: itemName.trim(), sellingRate: selling.value, unit: selling.unit });
    }
  }

  return results;
}
