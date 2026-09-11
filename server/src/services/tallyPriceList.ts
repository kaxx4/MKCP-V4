/**
 * The price list, read straight from Tally.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 * Keeping the dashboard's prices current has been a manual step: export the
 * price list from Tally by hand, then import it in the web app's Price List
 * page. That is one of the ten manual steps the rebuild is removing, and it is
 * the one that silently goes stale — nothing tells you the import is three
 * months old, the numbers just quietly stop matching the books.
 *
 * `FULLPRICELIST` carries the entire catalogue, so the manual round trip is
 * unnecessary. Measured against the live company (2026-09-12):
 *
 *   490 items, 489 with at least one priced entry ....  1.30 MB in 0.18s
 *
 * That is cheap enough to pull on the ordinary master cadence.
 *
 * ── The shape, verified rather than assumed ───────────────────────────────
 * Each `FULLPRICELIST.LIST` block is exactly one (date, price level) pair:
 *
 *   <FULLPRICELIST.LIST>
 *     <DATE>20260401</DATE>
 *     <PRICELEVEL>Dealer</PRICELEVEL>
 *     <PRICELEVELLIST.LIST>
 *       <ENDINGAT/><STARTINGFROM/>
 *       <RATE>995.24/PC</RATE>
 *       <DISCOUNT>0</DISCOUNT>
 *     </PRICELEVELLIST.LIST>
 *   </FULLPRICELIST.LIST>
 *
 * Confirmed across all 4,255 blocks in the catalogue: never more than one
 * PRICELEVEL per block, never more than one PRICELEVELLIST, and not one
 * quantity band anywhere (STARTINGFROM/ENDINGAT are empty throughout). Blocks
 * arrive in ascending date order, oldest first.
 *
 * ⚠ Two traps, both of which produce a half-populated catalogue with no error:
 *
 * 1. `<PRICELEVEL[^>]*>` ALSO MATCHES `<PRICELEVELLIST.LIST>` — the list
 *    element's name begins with the scalar's. A pattern without the closing tag
 *    reports every block as carrying several price levels. Always require
 *    `</PRICELEVEL>`.
 *
 * 2. `DEALER` and `Dealer` are the SAME price level, entered with different
 *    capitalisation over twenty years of history — both spellings appear within
 *    a single item's own timeline. A lookup keyed on the raw name splits the
 *    catalogue in two (2,549 rows against 1,695) and a rate lookup misses
 *    roughly 40% of the time. Names are folded on read; the raw spelling is
 *    kept alongside so the operator can still see what Tally holds.
 */

import { tallyPost } from "../tally.js";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** One dated rate for one item at one price level. */
export interface PriceListEntry {
  itemName: string;
  /** Case-folded for lookups — see trap 2 above. */
  priceLevel: string;
  /** The spelling Tally actually holds, for display. */
  priceLevelRaw: string;
  /** ISO date the rate took effect, "YYYY-MM-DD". */
  date: string;
  rate: number;
  /** The unit the rate is quoted in, e.g. "PC" from "995.24/PC". */
  unit: string;
  discountPct: number;
}

const TAG = (body: string, tag: string): string => {
  const m = new RegExp(`<${tag}>([^<]*)</${tag}>`, "i").exec(body);
  return m ? m[1].trim() : "";
};

/** Tally dates arrive as YYYYMMDD with no separators. */
function isoDate(yyyymmdd: string): string {
  const s = yyyymmdd.trim();
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : "";
}

/**
 * Split "995.24/PC" into its number and unit.
 *
 * The rate is NOT a bare number — it carries the unit it is quoted in, and a
 * plain parseFloat would silently drop that. Two items quoted per-PC and
 * per-BOX are not comparable, so the unit travels with the rate.
 */
export function parseRate(raw: string): { rate: number; unit: string } {
  const s = (raw ?? "").trim();
  const slash = s.indexOf("/");
  const numPart = slash >= 0 ? s.slice(0, slash) : s;
  const unit = slash >= 0 ? s.slice(slash + 1).trim() : "";
  const rate = parseFloat(numPart.replace(/,/g, ""));
  return { rate: Number.isFinite(rate) ? rate : 0, unit };
}

/** Parse a whole `FULLPRICELIST` collection response into flat dated entries. */
export function parsePriceList(xml: string): PriceListEntry[] {
  const out: PriceListEntry[] = [];

  for (const [, attrs, body] of xml.matchAll(/<STOCKITEM\b([^>]*)>([\s\S]*?)<\/STOCKITEM>/g)) {
    // A stock item carries its name as an ATTRIBUTE, not a child element — and
    // the attribute list also holds RESERVEDNAME="", so a greedy NAME=" match
    // grabs the wrong one. Anchor on a word boundary.
    const itemName = /(?:^|\s)NAME="([^"]*)"/.exec(attrs)?.[1]?.trim() ?? "";
    if (!itemName) continue;

    for (const [, block] of body.matchAll(/<FULLPRICELIST\.LIST>([\s\S]*?)<\/FULLPRICELIST\.LIST>/g)) {
      const date = isoDate(TAG(block, "DATE"));
      const priceLevelRaw = TAG(block, "PRICELEVEL");
      if (!date || !priceLevelRaw) continue;

      const { rate, unit } = parseRate(TAG(block, "RATE"));
      if (!rate) continue; // a level with no rate tells us nothing

      out.push({
        itemName: unescapeXml(itemName),
        priceLevel: normalizeLevel(priceLevelRaw),
        priceLevelRaw: unescapeXml(priceLevelRaw),
        date,
        rate,
        unit,
        discountPct: parseFloat(TAG(block, "DISCOUNT")) || 0,
      });
    }
  }
  return out;
}

/** Fold a price-level name for lookups. See trap 2 in the header. */
export function normalizeLevel(name: string): string {
  return unescapeXml(name).trim().toUpperCase();
}

function unescapeXml(s: string): string {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'");
}

/**
 * The rate in force for each item and price level, as at a date.
 *
 * A price list is a history, not a snapshot: the catalogue holds 4,255 dated
 * entries going back to 2003. "The price" means the most recent entry NOT AFTER
 * the date being asked about — which also makes a backdated voucher price
 * itself the way it would have been priced at the time, instead of at today's
 * rate.
 */
export function latestRates(
  entries: PriceListEntry[],
  asOf?: string,
): Map<string, PriceListEntry> {
  const best = new Map<string, PriceListEntry>();
  for (const e of entries) {
    if (asOf && e.date > asOf) continue;
    const key = `${e.itemName.toUpperCase()}|${e.priceLevel}`;
    const held = best.get(key);
    // Ties go to the LAST one seen: Tally emits blocks oldest-first, so the
    // later of two same-dated entries is the one that stands.
    if (!held || e.date >= held.date) best.set(key, e);
  }
  return best;
}

/** Convenience: one item's rate at one level, or undefined. */
export function rateFor(
  latest: Map<string, PriceListEntry>,
  itemName: string,
  priceLevel: string,
): PriceListEntry | undefined {
  return latest.get(`${itemName.trim().toUpperCase()}|${normalizeLevel(priceLevel)}`);
}

/**
 * Ask Tally for the whole price list.
 *
 * One request for the entire catalogue — 1.3 MB, well under a second. There is
 * no incremental form of this and no need for one: a filtered variant would
 * cost a TDL FILTER evaluation per item for no measurable saving.
 */
export async function fetchPriceList(
  tallyUrl: string,
  company: string,
  signal?: AbortSignal,
): Promise<PriceListEntry[]> {
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>MkPriceList</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="MkPriceList" ISMODIFY="No"><TYPE>StockItem</TYPE>
<NATIVEMETHOD>Name</NATIVEMETHOD><NATIVEMETHOD>FullPriceList</NATIVEMETHOD>
</COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;

  const raw = await tallyPost(tallyUrl, xml, 240_000, true, signal) as string;
  return parsePriceList(raw);
}
