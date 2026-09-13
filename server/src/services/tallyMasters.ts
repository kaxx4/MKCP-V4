/**
 * Live master cache for the push path.
 *
 * Exists because Tally silently discards a voucher fragment whose master name is
 * off by a single character. The real ledgers in this company are
 * `PURCHASE ( GST W.B. )` (one space) and `SALES  ( GST W.B. )` (two) — sending
 * the wrong one returns CREATED=1 and drops the whole accounting allocation.
 *
 * So: nothing on the push path may hardcode a master name. It resolves through
 * here, or it does not get sent.
 */
import { tallyPost } from "../tally.js";

/** One dated GST registration for a party. Tally keeps the whole history. */
export interface LedgerRegistration {
  /** YYYYMMDD. The date this registration came into force. */
  applicableFrom: string;
  gstin: string;
  registrationType: string;
  placeOfSupply: string;
  state: string;
}

export interface MasterLedger {
  name: string;
  parent: string;
  gstin: string;
  state: string;
  pincode: string;
  mailingName: string;
  address: string[];
  /** Dated GST registration history, oldest first. Empty when Tally holds none. */
  registrations: LedgerRegistration[];
}

export interface MasterItem {
  name: string;
  baseUnit: string;
  /** Units per pack for the item's compound unit; 1 when simple. */
  denominator: number;
  closingRate: number;
  closingStock: number;
  /**
   * COMBINED GST rate from the item's OWN GST details; 0 when it inherits.
   *
   * ⚠ This used to hold the CGST duty head alone, while being named for the
   * total — and CGST is HALF an intra-state rate. Tally publishes three heads
   * per item (verified 2026-09-12 via scripts/explore-gst-heads.ts):
   *
   *     CGST 6 · SGST/UTGST 6 · IGST 12
   *
   * so IGST is the combined figure and CGST+SGST reproduces it. Reading CGST
   * and calling it the rate understates every tax computed from it by half. No
   * live money was affected — the only consumer tested it for zero — but
   * regenerating the web app's GST master off this field reported 478 of 479
   * rates as "changed" (18→9, 12→6), which is what surfaced it.
   */
  gstRate: number;
  /** The individual heads, kept so a caller can see the split rather than infer it. */
  cgstRate: number;
  sgstRate: number;
  igstRate: number;
  /** Every dated revision, oldest first — see revisionOn / gstRateFor. */
  gstRevisions: GstRevision[];
  /** Stock group, i.e. where an inherited rate comes from. */
  parent: string;
  /** Tally's own word for where the rate resolves from, e.g. "As per Company/Stock Group". */
  gstRateSource: string;
}

/** A stock group's own GST rate, used when an item inherits rather than declares. */
export interface MasterStockGroup {
  name: string;
  parent: string;
  /** COMBINED rate as at today — see the warning on MasterItem.gstRate. */
  gstRate: number;
  cgstRate: number;
  sgstRate: number;
  igstRate: number;
  /** Every dated revision, oldest first. 16 of 22 groups carry three. */
  gstRevisions: GstRevision[];
}

export interface TallyMasters {
  company: string;
  loadedAt: number;
  ledgers: Map<string, MasterLedger>;
  items: Map<string, MasterItem>;
  /** Stock groups, for resolving a rate an item inherits rather than declares. */
  stockGroups: Map<string, MasterStockGroup>;
  godowns: Set<string>;
  units: Set<string>;
  /** Voucher types configured in THIS company. `Delivery Note` is not among them. */
  voucherTypes: Set<string>;
  /** Lowercased, whitespace-collapsed key → real name, for near-miss diagnostics. */
  ledgerLoose: Map<string, string>;
  itemLoose: Map<string, string>;
}

const unescapeXml = (s: string): string =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">")
   .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
   .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
   .replace(/&amp;/g, "&");            // last — else &amp;quot; double-decodes

const field = (block: string, tag: string): string => {
  const m = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`).exec(block);
  return m ? unescapeXml(m[1].trim()) : "";
};
/** Tally returns quantities as "8 PC =  2.00 PKG" — take the leading number only. */
const leadingNumber = (s: string): number => {
  const m = /^\s*(-?[\d.]+)/.exec(s.replace(/,/g, ""));
  return m ? parseFloat(m[1]) : 0;
};
const looseKey = (s: string) => s.replace(/\s+/g, " ").trim().toUpperCase();
const escXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function collectionXml(id: string, type: string, fields: string[], company: string): string {
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>${id}</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${escXml(company)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="${id}" ISMODIFY="No"><TYPE>${type}</TYPE>
${fields.map(f => `<NATIVEMETHOD>${f}</NATIVEMETHOD>`).join("\n")}
</COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
}

const CACHE_TTL_MS = 10 * 60_000;
let cache: TallyMasters | null = null;

/**
 * Load (or reuse) the master cache. Tally is single-threaded on this port, so
 * the four collections are fetched two at a time rather than all at once.
 */
export async function loadMasters(
  tallyUrl: string,
  company: string,
  opts: { force?: boolean } = {}
): Promise<TallyMasters> {
  if (!opts.force && cache && cache.company === company && Date.now() - cache.loadedAt < CACHE_TTL_MS) {
    return cache;
  }

  const [ledXml, itemXml] = await Promise.all([
    tallyPost(tallyUrl, collectionXml("MkLedgers", "Ledger",
      ["Name", "Parent", "PartyGSTIN", "GSTIN", "LedStateName", "PinCode", "MailingName", "Address", "LedGSTRegDetails"],
      company), 180_000, true) as Promise<string>,
    tallyPost(tallyUrl, collectionXml("MkItems", "StockItem",
      ["Name", "Parent", "BaseUnits", "Denominator", "ClosingBalance", "ClosingRate", "GSTDetails", "SrcOfGSTDetails"],
      company), 180_000, true) as Promise<string>,
  ]);
  const [godownXml, unitXml, vtXml, sgXml] = await Promise.all([
    tallyPost(tallyUrl, collectionXml("MkGodowns", "Godown", ["Name"], company), 60_000, true) as Promise<string>,
    tallyPost(tallyUrl, collectionXml("MkUnits", "Unit", ["Name"], company), 60_000, true) as Promise<string>,
    tallyPost(tallyUrl, collectionXml("MkVchTypes", "VoucherType", ["Name", "Parent"], company), 60_000, true) as Promise<string>,
    tallyPost(tallyUrl, collectionXml("MkStkGroups", "StockGroup", ["Name", "Parent", "GSTDetails"], company), 60_000, true) as Promise<string>,
  ]);

  const ledgers = new Map<string, MasterLedger>();
  const ledgerLoose = new Map<string, string>();
  for (const m of ledXml.matchAll(/<LEDGER\b[^>]*>[\s\S]*?<\/LEDGER>/g)) {
    const b = m[0];
    const name = field(b, "NAME");
    if (!name) continue;
    /**
     * A party's GST registration is DATED — Tally keeps the history in
     * LEDGSTREGDETAILS.LIST, each entry stamped APPLICABLEFROM. A GSTIN, place
     * of supply or registration type can change, and a voucher must carry the
     * registration in force **on its own date**.
     *
     * That matters here more than most places: 61% of this company's vouchers
     * are backdated, so taking today's registration would stamp a months-old
     * invoice with a registration that did not apply then — the same class of
     * GSTR-1 problem as omitting the registration altogether, just harder to see.
     */
    const registrations = [...b.matchAll(/<LEDGSTREGDETAILS\.LIST>([\s\S]*?)<\/LEDGSTREGDETAILS\.LIST>/g)]
      .map(x => x[1])
      .map(blk => ({
        applicableFrom: field(blk, "APPLICABLEFROM"),
        gstin: field(blk, "GSTIN"),
        registrationType: field(blk, "GSTREGISTRATIONTYPE"),
        placeOfSupply: field(blk, "PLACEOFSUPPLY"),
        state: field(blk, "STATE"),
      }))
      .filter(r => r.applicableFrom || r.gstin)
      .sort((a, b2) => a.applicableFrom.localeCompare(b2.applicableFrom));

    ledgers.set(name, {
      name,
      parent: field(b, "PARENT"),
      // Flat fields remain the fallback for parties with no dated history.
      gstin: field(b, "PARTYGSTIN") || field(b, "GSTIN"),
      state: field(b, "LEDSTATENAME"),
      pincode: field(b, "PINCODE"),
      mailingName: field(b, "MAILINGNAME") || name,
      address: [...b.matchAll(/<ADDRESS>([^<]*)<\/ADDRESS>/g)].map(x => unescapeXml(x[1].trim())).filter(Boolean),
      registrations,
    });
    ledgerLoose.set(looseKey(name), name);
  }

  const items = new Map<string, MasterItem>();
  const itemLoose = new Map<string, string>();
  for (const m of itemXml.matchAll(/<STOCKITEM\b[^>]*>[\s\S]*?<\/STOCKITEM>/g)) {
    const b = m[0];
    const name = field(b, "NAME");
    if (!name) continue;
    items.set(name, {
      name,
      baseUnit: field(b, "BASEUNITS") || "PC",
      denominator: leadingNumber(field(b, "DENOMINATOR")) || 1,
      closingRate: leadingNumber(field(b, "CLOSINGRATE")),
      closingStock: leadingNumber(field(b, "CLOSINGBALANCE")),
      ...gstRates(b),
      parent: field(b, "PARENT"),
      gstRateSource: field(b, "SRCOFGSTDETAILS"),
    });
    itemLoose.set(looseKey(name), name);
  }

  /**
   * A stock group does NOT carry its name as a child element — it is an
   * ATTRIBUTE: `<STOCKGROUP NAME="BICYCLE ( 87120010 )">`. Looking for `<NAME>`
   * inside finds nothing and silently yields zero groups, which is
   * indistinguishable from "this company has none".
   *
   * The response also opens with a COUNT summary (`<STOCKGROUP>28</STOCKGROUP>`)
   * that is not an object at all; requiring the attribute skips it.
   *
   * The \b matters: the tag is `<STOCKGROUP NAME="..." RESERVEDNAME="">`, and a
   * greedy `[^>]*NAME="` happily matches the tail of RESERVEDNAME instead,
   * capturing an empty string and dropping every group on the floor.
   */
  const stockGroups = new Map<string, MasterStockGroup>();
  for (const m of sgXml.matchAll(/<STOCKGROUP(\s[^>]*)>([\s\S]*?)<\/STOCKGROUP>/g)) {
    // Pulled out of the attribute list in its own step. Matching NAME=" inside
    // the tag directly does not work: the tag is
    //   <STOCKGROUP NAME="BICYCLE ( 87120010 )" RESERVEDNAME="">
    // and a greedy scan reaches the NAME at the tail of RESERVEDNAME first,
    // capturing "" and silently discarding every group.
    const nameAttr = /(?:^|\s)NAME="([^"]*)"/.exec(m[1]);
    const name = nameAttr ? unescapeXml(nameAttr[1]).trim() : "";
    const b = m[2];
    if (!name) continue;
    stockGroups.set(name, {
      name,
      parent: field(b, "PARENT"),
      ...gstRates(b),
    });
  }

  const godowns = new Set<string>();
  for (const m of godownXml.matchAll(/<GODOWN\b[^>]*>[\s\S]*?<\/GODOWN>/g)) {
    const n = field(m[0], "NAME");
    if (n) godowns.add(n);
  }
  const units = new Set<string>();
  for (const m of unitXml.matchAll(/<UNIT\b[^>]*>[\s\S]*?<\/UNIT>/g)) {
    const n = field(m[0], "NAME");
    if (n) units.add(n);
  }

  const voucherTypes = new Set<string>();
  for (const m of vtXml.matchAll(/<VOUCHERTYPE\b[^>]*>[\s\S]*?<\/VOUCHERTYPE>/g)) {
    const n = field(m[0], "NAME");
    if (n) voucherTypes.add(n);
  }

  cache = { company, loadedAt: Date.now(), ledgers, items, stockGroups, godowns, units, voucherTypes, ledgerLoose, itemLoose };
  console.log(`[masters] ${ledgers.size} ledgers, ${items.size} items, ${stockGroups.size} stock groups, ${godowns.size} godowns, ${units.size} units, ${voucherTypes.size} voucher types`);
  return cache;
}

export function invalidateMasters(): void { cache = null; }

/** Thrown rather than returned — a bad master name must never reach Tally. */
export class MasterResolutionError extends Error {
  constructor(public readonly kind: string, public readonly wanted: string, public readonly suggestion?: string) {
    super(suggestion
      ? `${kind} "${wanted}" does not exist. Tally spells it "${suggestion}" — names are whitespace- and case-exact.`
      : `${kind} "${wanted}" does not exist in this company.`);
    this.name = "MasterResolutionError";
  }
}

export function resolveLedger(m: TallyMasters, name: string): MasterLedger {
  const hit = m.ledgers.get(name);
  if (hit) return hit;
  const near = m.ledgerLoose.get(looseKey(name));
  throw new MasterResolutionError("Ledger", name, near);
}

export function resolveItem(m: TallyMasters, name: string): MasterItem {
  const hit = m.items.get(name);
  if (hit) return hit;
  const near = m.itemLoose.get(looseKey(name));
  throw new MasterResolutionError("Stock item", name, near);
}

/** Non-throwing variants for validation, which collects every problem at once. */
export function findLedger(m: TallyMasters, name: string): MasterLedger | { miss: true; suggestion?: string } {
  const hit = m.ledgers.get(name);
  return hit ?? { miss: true, suggestion: m.ledgerLoose.get(looseKey(name)) };
}
export function findItem(m: TallyMasters, name: string): MasterItem | { miss: true; suggestion?: string } {
  const hit = m.items.get(name);
  return hit ?? { miss: true, suggestion: m.itemLoose.get(looseKey(name)) };
}
export const isMiss = (x: unknown): x is { miss: true; suggestion?: string } =>
  typeof x === "object" && x !== null && (x as { miss?: boolean }).miss === true;

/**
 * The GST registration in force for a party on a given date.
 *
 * Tally stamps each registration `APPLICABLEFROM`, so "the party's GSTIN" is not
 * a single value — it is whichever entry was current on the voucher's own date.
 * With 61% of this company's vouchers backdated, reading the flat field would
 * regularly stamp an old invoice with a registration that did not exist yet.
 *
 * Falls back to the flat master fields when a party carries no dated history,
 * which is the common case for parties whose details have never changed.
 */
export function registrationOn(led: MasterLedger, isoDate: string): {
  gstin: string; registrationType: string; placeOfSupply: string; state: string;
} {
  const stamp = isoDate.replace(/-/g, "");
  // Entries are oldest-first; the one in force is the latest that has started.
  const inForce = [...led.registrations]
    .filter(r => !r.applicableFrom || r.applicableFrom <= stamp)
    .pop();

  const gstin = inForce?.gstin || led.gstin;
  return {
    gstin,
    registrationType: inForce?.registrationType || (gstin ? "Regular" : "Unregistered"),
    // Place of supply drives CGST+SGST vs IGST, so prefer the dated value and
    // only then the ledger's own state.
    placeOfSupply: inForce?.placeOfSupply || inForce?.state || led.state,
    state: inForce?.state || inForce?.placeOfSupply || led.state,
  };
}

/**
 * The CGST rate that will actually apply to an item, and where it came from.
 *
 * A rate is NOT simply a field on the item. `SRCOFGSTDETAILS` on this company's
 * items commonly reads "As per Company/Stock Group", meaning the item declares
 * nothing and inherits. Reading only the item's own rate returns 0 for most of
 * the catalogue — and a voucher built on that files under GSTR-1's "Tax Rate is
 * not specified".
 *
 * Resolution order, matching Tally: the item's own rate, then its stock group's,
 * then walking up the group tree, then nothing.
 */
/**
 * Read every dated GST revision off an item or stock-group block.
 *
 * ── Rates are DATED, and Tally keeps every revision ───────────────────────
 * Each object carries one GSTDETAILS.LIST per rate change, stamped with
 * APPLICABLEFROM. The BICYCLE ( 87120010 ) group holds three:
 *
 *     from 20170701   CGST 6    SGST 6    IGST 12
 *     from 20220401   CGST 6    SGST 6    IGST 12
 *     from 20250922   CGST 2.5  SGST 2.5  IGST 5     ← current
 *
 * Bicycles and parts moved to 5% on 22 September 2025. Taking the FIRST block —
 * which is what this code used to do — returns the 2017 rate, wrong by more
 * than double and wrong for over a year. 16 of 22 stock groups carry three
 * revisions, so this is the normal case, not an edge one.
 *
 * ── And the head matters as much as the date ──────────────────────────────
 * Rates live at GSTDETAILS.LIST > STATEWISEDETAILS.LIST > RATEDETAILS.LIST, one
 * RATEDETAILS block per duty head. IGST is the COMBINED rate; CGST and SGST are
 * halves of it. Reading CGST and calling it "the GST rate" understates every
 * figure derived from it by half. IGST is preferred because Tally publishes it
 * directly; CGST+SGST is the fallback for a master declaring only the
 * intra-state pair.
 *
 * Note `<GSTRATE> 6</GSTRATE>` — Tally pads values with a leading space, so
 * captures are trimmed before parsing.
 */
export interface GstRevision {
  /** ISO date the rate took effect, "YYYY-MM-DD"; "" when undated. */
  from: string;
  /** Combined rate — IGST, or CGST+SGST when IGST is absent. */
  rate: number;
  cgst: number;
  sgst: number;
  igst: number;
  /** Tally's own word, e.g. "Taxable", "Exempt", "Nil Rated". */
  taxability: string;
}

function dutyHead(block: string, name: string): number {
  const m = new RegExp(
    `<GSTRATEDUTYHEAD>\\s*${name}\\s*</GSTRATEDUTYHEAD>[\\s\\S]{0,300}?<GSTRATE>\\s*([^<]*?)\\s*</GSTRATE>`,
    "i",
  ).exec(block);
  return m ? parseFloat(m[1]) || 0 : 0;
}

function gstRevisions(block: string): GstRevision[] {
  const out: GstRevision[] = [];
  for (const [, b] of block.matchAll(/<GSTDETAILS\.LIST>([\s\S]*?)<\/GSTDETAILS\.LIST>/g)) {
    const raw = /<APPLICABLEFROM>\s*([^<]*?)\s*<\/APPLICABLEFROM>/.exec(b)?.[1] ?? "";
    const cgst = dutyHead(b, "CGST");
    // The head is spelled "SGST/UTGST"; named in full rather than relying on a
    // prefix match.
    const sgst = dutyHead(b, "SGST/UTGST") || dutyHead(b, "SGST");
    const igst = dutyHead(b, "IGST");
    out.push({
      from: /^\d{8}$/.test(raw) ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}` : "",
      rate: igst || cgst + sgst,
      cgst, sgst, igst,
      taxability: /<TAXABILITY>\s*([^<]*?)\s*<\/TAXABILITY>/.exec(b)?.[1] ?? "",
    });
  }
  // Oldest first, so "the latest not after a date" is a simple scan.
  return out.sort((a, b) => a.from.localeCompare(b.from));
}

/** The revision in force on a date — the newest one NOT AFTER it. */
export function revisionOn(revisions: GstRevision[], asOf?: string): GstRevision | undefined {
  let best: GstRevision | undefined;
  for (const r of revisions) {
    if (asOf && r.from && r.from > asOf) continue;
    if (!best || r.from >= best.from) best = r;
  }
  return best;
}

/** Flatten revisions into the fields a caller reads directly, as at today. */
function gstRates(block: string): {
  gstRate: number; cgstRate: number; sgstRate: number; igstRate: number; gstRevisions: GstRevision[];
} {
  const revisions = gstRevisions(block);
  const now = revisionOn(revisions, new Date().toISOString().slice(0, 10));
  return {
    gstRate: now?.rate ?? 0,
    cgstRate: now?.cgst ?? 0,
    sgstRate: now?.sgst ?? 0,
    igstRate: now?.igst ?? 0,
    gstRevisions: revisions,
  };
}

/**
 * The GST rate for an item, as at a date.
 *
 * `asOf` defaults to today. Pass the VOUCHER's date when pricing one: a voucher
 * backdated across 22 September 2025 must be rated at the rate that applied
 * then, not at today's.
 *
 * Resolution order is Tally's own: the item's own declaration, then up the
 * stock-group tree. Only 36 of 489 items declare a rate; 453 inherit.
 */
export function gstRateFor(
  m: TallyMasters,
  itemName: string,
  asOf?: string,
): { rate: number; source: string; revision?: GstRevision } {
  const item = m.items.get(itemName);
  if (!item) return { rate: 0, source: "unknown item" };

  const own = revisionOn(item.gstRevisions, asOf);
  if (own && own.rate > 0) return { rate: own.rate, source: "item", revision: own };

  // Walk up the stock-group tree; guard against a cycle in the master data.
  let groupName = item.parent;
  const seen = new Set<string>();
  while (groupName && !seen.has(groupName)) {
    seen.add(groupName);
    const g = m.stockGroups.get(groupName);
    if (!g) break;
    const r = revisionOn(g.gstRevisions, asOf);
    if (r && r.rate > 0) return { rate: r.rate, source: `stock group "${g.name}"`, revision: r };
    groupName = g.parent;
  }
  return { rate: 0, source: item.gstRateSource || "none found" };
}
