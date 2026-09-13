/**
 * GST rates, read from Tally instead of from a file in the repo.
 *
 * ── What this replaces ────────────────────────────────────────────────────
 *
 * `src/data/gstMasterRates.json` in the web app — a checked-in snapshot with no
 * import path at all. Changing a rate means editing a file and redeploying, and
 * it is load-bearing for money: `engine/cashInvoice.ts` uses presence in that
 * file to decide whether a line takes its rate from the item or the stock group.
 *
 * ── Four traps, all measured against the live company ─────────────────────
 *
 * 1. THE RATE LIVES ON THE STOCK GROUP, NOT THE ITEM.
 *    Measured 13-Sep-2026: of 507 item-level GSTDETAILS blocks, 458 say
 *    `SRCOFGSTDETAILS = "As per Company/Stock Group"` and only 49 declare their
 *    own. Of 59 stock-group blocks, 57 declare one. A lookup that reads only the
 *    item finds nothing for most of the catalogue.
 *
 * 2. READ IGST, NOT CGST. Inside `RATEDETAILS.LIST` the duty heads are separate
 *    rows: CGST 6, SGST/UTGST 6, IGST 12. IGST carries the FULL rate; the other
 *    two are halves of it. Reading CGST and using it as the rate halves every
 *    invoice.
 *
 * 3. THE VALUE ARRIVES WITH A LEADING SPACE — `<GSTRATE TYPE="Number"> 6</GSTRATE>`.
 *    `parseFloat` copes; a strict comparison or a `Number()` on an untrimmed
 *    string does not.
 *
 * 4. RATES ARE DATED, and the newest block is not first. `APPLICABLEFROM`
 *    values observed include 20170701, 20210401, 20220401, 20250922 — the day
 *    bicycles moved to 5%. A voucher backdated across that boundary needs the
 *    rate that was in force THEN, so this keeps the history rather than the
 *    latest value.
 */
import { tallyPost } from "../tally.js";
import { buildCollection, blocksOf, tagOf } from "./tallyRequest.js";

export interface GstRateEntry {
  scope: "item" | "stock_group";
  name: string;
  /** ISO "YYYY-MM-DD". Tally's APPLICABLEFROM. */
  effectiveFrom: string;
  /** The full rate — IGST where present, else CGST + SGST. */
  gstRate: number;
  cgst: number;
  sgst: number;
  igst: number;
  /** Tally's own word: "Taxable", "Exempt", "Nil Rated". Not interchangeable. */
  taxability: string;
  /** For an item that defers, the group it inherits from. */
  parent?: string;
  /** True when this object declares its own rate rather than deferring. */
  declaresOwn: boolean;
}

/** "20250922" → "2025-09-22". Returns null for anything that is not 8 digits. */
function isoDate(raw: string): string | null {
  const d = raw.trim();
  if (!/^\d{8}$/.test(d)) return null;
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

/** Trap 3: the value arrives as " 6". */
function num(raw: string | undefined): number {
  const n = parseFloat((raw ?? "").trim());
  return Number.isFinite(n) ? n : 0;
}

/**
 * Pull the rate out of one STATEWISEDETAILS block.
 *
 * Duty heads are separate RATEDETAILS.LIST rows keyed by GSTRATEDUTYHEAD, so
 * they are read by name rather than by position — the order is not guaranteed
 * and "the third one" is not a contract.
 */
function ratesFrom(block: string): { cgst: number; sgst: number; igst: number } {
  let cgst = 0, sgst = 0, igst = 0;
  for (const m of block.matchAll(/<RATEDETAILS\.LIST>([\s\S]*?)<\/RATEDETAILS\.LIST>/gi)) {
    const head = (tagOf(m[1], "GSTRATEDUTYHEAD") ?? "").trim().toUpperCase();
    const rate = num(tagOf(m[1], "GSTRATE"));
    if (head === "CGST") cgst = rate;
    else if (head.startsWith("SGST")) sgst = rate;   // Tally says "SGST/UTGST"
    else if (head === "IGST") igst = rate;
  }
  return { cgst, sgst, igst };
}

/** Parse every dated GSTDETAILS block out of one master object. */
function entriesFor(
  objectXml: string,
  scope: "item" | "stock_group",
): GstRateEntry[] {
  const name = (tagOf(objectXml, "NAME") ?? "").trim();
  if (!name) return [];
  const parent = (tagOf(objectXml, "PARENT") ?? "").trim() || undefined;

  const out: GstRateEntry[] = [];
  for (const m of objectXml.matchAll(/<GSTDETAILS\.LIST>([\s\S]*?)<\/GSTDETAILS\.LIST>/gi)) {
    const body = m[1];
    const from = isoDate(tagOf(body, "APPLICABLEFROM") ?? "");
    if (!from) continue;

    const src = (tagOf(body, "SRCOFGSTDETAILS") ?? "").trim();
    const declaresOwn = /specify details here/i.test(src);
    const taxability = (tagOf(body, "TAXABILITY") ?? "").trim();

    const { cgst, sgst, igst } = ratesFrom(body);
    // Trap 2: IGST is the full rate. Fall back to the halves only if it is absent.
    const gstRate = igst > 0 ? igst : cgst + sgst;

    // An object that defers carries the block but no numbers. Keep it only when
    // it actually declares something — otherwise every item would contribute a
    // zero-rate row that outranks the group it should have inherited from.
    if (!declaresOwn && gstRate === 0) continue;

    out.push({ scope, name, effectiveFrom: from, gstRate, cgst, sgst, igst, taxability, parent, declaresOwn });
  }
  return out;
}

/**
 * Every declared GST rate in the company, at both levels.
 *
 * Two requests, both cheap — measured at 861 KB / 62 ms for items and
 * 98 KB / 15 ms for groups.
 */
export async function fetchGstRates(tallyUrl: string, company: string): Promise<GstRateEntry[]> {
  const itemsXml: string = await tallyPost(
    tallyUrl,
    buildCollection({ id: "MkGstItems", type: "StockItem", fetch: ["NAME", "PARENT", "GSTDETAILS.LIST"], company }),
    240_000,
    true,
  );
  const groupsXml: string = await tallyPost(
    tallyUrl,
    buildCollection({ id: "MkGstGroups", type: "StockGroup", fetch: ["NAME", "PARENT", "GSTDETAILS.LIST"], company }),
    120_000,
    true,
  );

  const out: GstRateEntry[] = [];
  for (const b of blocksOf(itemsXml, "STOCKITEM")) out.push(...entriesFor(b, "item"));
  for (const b of blocksOf(groupsXml, "STOCKGROUP")) out.push(...entriesFor(b, "stock_group"));
  return out;
}

/**
 * The rate in force for an item on a given date.
 *
 * Resolves item → stock group, newest-not-after-the-date at each level. Returns
 * null rather than guessing: a caller that needs a fallback should apply its own
 * and say that it did, because a guessed rate on a real invoice is a filing
 * error nobody sees until the return.
 */
export interface ResolvedRate {
  rate: number;
  /** Where it came from — what the operator needs when a rate looks wrong. */
  from: "item" | "stock_group";
  sourceName: string;
  effectiveFrom: string;
  taxability: string;
}

export function resolveRate(
  entries: GstRateEntry[],
  itemName: string,
  stockGroup: string | undefined,
  asOf: string,
): ResolvedRate | null {
  const pick = (scope: "item" | "stock_group", name: string): GstRateEntry | null => {
    const key = name.trim().toUpperCase();
    let best: GstRateEntry | null = null;
    for (const e of entries) {
      if (e.scope !== scope) continue;
      if (e.name.trim().toUpperCase() !== key) continue;
      if (e.effectiveFrom > asOf) continue;               // never a future rate
      if (!best || e.effectiveFrom >= best.effectiveFrom) best = e;
    }
    return best;
  };

  const own = pick("item", itemName);
  if (own && own.gstRate > 0) {
    return { rate: own.gstRate, from: "item", sourceName: own.name, effectiveFrom: own.effectiveFrom, taxability: own.taxability };
  }

  if (stockGroup) {
    const grp = pick("stock_group", stockGroup);
    if (grp && grp.gstRate > 0) {
      return { rate: grp.gstRate, from: "stock_group", sourceName: grp.name, effectiveFrom: grp.effectiveFrom, taxability: grp.taxability };
    }
  }

  return null;
}
