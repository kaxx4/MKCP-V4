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

/**
 * Parses the Tally JSON price list export.
 * Handles UTF-16 LE BOM (ÿþ / \uFEFF) automatically.
 *
 * Expected structure:
 *   TALLYMESSAGE.STOCKITEM[].FULLPRICELIST
 *     .mpsstockitemname   — item name
 *     .mpspricelist.PRICELEVELLIST[0]
 *       .mpsprevrate      — selling rate, e.g. "799.11/PC"
 *       .mpscostprice     — cost price, e.g. "660.25/PC"
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

  const stockItems: any[] = parsed?.TALLYMESSAGE?.STOCKITEM;
  if (!Array.isArray(stockItems)) {
    throw new Error("Expected TALLYMESSAGE.STOCKITEM array");
  }

  const results: TallyPriceEntry[] = [];

  for (const stockItem of stockItems) {
    const pl = stockItem?.FULLPRICELIST;
    if (!pl) continue;

    const itemName: string | undefined = pl.mpsstockitemname;
    if (!itemName) continue;

    const pricelevel = pl?.mpspricelist?.PRICELEVELLIST?.[0];
    const selling = parseRateString(pricelevel?.mpsprevrate ?? "");
    const cost = parseRateString(pricelevel?.mpscostprice ?? "");

    if (!selling) continue;

    results.push({
      itemName: itemName.trim(),
      sellingRate: selling.value,
      costPrice: cost?.value,
      unit: selling.unit,
    });
  }

  return results;
}
