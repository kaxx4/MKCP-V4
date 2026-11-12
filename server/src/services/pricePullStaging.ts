/**
 * JOB: write each price-list pull into `erp_price_pull_staging` with WHO ASKED, and copy an accepted pull into the list (F11 agent half; D-8-4.15, D-8-4.28, D-M.92, D-M.187).
 *
 * Migration 0261 (applied) holds a pull for a decision before it replaces the dealer price list. The web page already reads it. Its rule for who may
 * decide fails closed: a manual pull whose requester is empty is decided by the Owner alone; a scheduled pull (nobody asked) by the Owner or the
 * Checker; and "who asked is fixed when the pull is written" (0279). So the agent's part is: write the pull at insert with the requester it knows.
 *
 *   requesterFrom      the person a refresh command names, as a lower-case uuid, or null when it names nobody (the web has always
 *                      written the text "web", which is not a person: that stays null and the Owner alone decides it).
 *   mergeRequesters    several commands coalesce into ONE pull. One person for all of them names that person; two different people, or
 *                      any command that names nobody, names nobody. Never a guess.
 *   stagedRates        the pull's rows as the table keeps them. Each row also keeps the price level and the discount, which the page
 *                      ignores, so an accepted pull can be copied into the list without losing them.
 *   stagingRow         the insert, with the server's rules in mind (the server stamps the time; a test pull is marked and its company is ZZ TEST).
 *   writePull          one INSERT. Never an update, never a delete: a written pull is the database's.
 *   applyAccepted      copy the NEWEST accepted pull for the company into the list in force, once (the caller keeps the last id copied).
 *
 * Hold mode (`MKCP_PRICE_PULL_HOLD=on`, default OFF): the pull is written to staging and NOT to the list. Off, nothing changes: the pull goes straight
 * to the list as it always has. Turning it on is the coordinator's go-live decision (NEEDS COORDINATOR).
 */
import type { PriceListEntry } from "./tallyPriceList.js";

export const STAGING_TABLE = "erp_price_pull_staging";
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const holdModeOn = (env: NodeJS.ProcessEnv = process.env): boolean => (env.MKCP_PRICE_PULL_HOLD ?? "").trim().toLowerCase() === "on";

/** The person a refresh command names, or null. Only a real uuid counts; "web", blank and anything else name nobody. */
export function requesterFrom(requestedBy: unknown): string | null {
  const v = typeof requestedBy === "string" ? requestedBy.trim() : "";
  return UUID_RE.test(v) ? v.toLowerCase() : null;
}

/** One pull serves several coalesced commands. A single named person for all of them names that person; otherwise nobody. */
export function mergeRequesters(list: readonly unknown[]): string | null {
  if (list.length === 0) return null;
  const ids = list.map(requesterFrom);
  if (ids.some((x) => x === null)) return null;
  return new Set(ids).size === 1 ? ids[0] : null;
}

export interface StagedRate {
  item_name: string; rate: number; unit: string | null; effective_from: string | null;
  /** Kept for the copy into the list; the page ignores them. */
  price_level: string; price_level_raw: string; discount_pct: number;
}

/** The dealer rows of a pull (the page and the table speak of the DEALER level). Every row of other levels is left out. */
export function stagedRates(entries: readonly PriceListEntry[], level = "DEALER"): StagedRate[] {
  const want = level.trim().toLowerCase();
  return entries
    .filter((e) => (e.priceLevel ?? "").trim().toLowerCase() === want && e.itemName && Number.isFinite(e.rate))
    .map((e) => ({
      item_name: e.itemName, rate: e.rate, unit: e.unit || null, effective_from: e.date ? String(e.date).slice(0, 10) : null,
      price_level: e.priceLevel, price_level_raw: e.priceLevelRaw, discount_pct: Number.isFinite(e.discountPct) ? e.discountPct : 0,
    }));
}

export type PullOrigin = "daily" | "manual";
/** The route's origin text decides the table's: the scheduled daily job is `daily`; anything a person or the web asked for is `manual`. */
export const originOf = (routeOrigin: string): PullOrigin => (/scheduled|daily/i.test(routeOrigin) ? "daily" : "manual");

export interface StagingInsert {
  company: string; price_level: string; origin: PullOrigin; rates: StagedRate[]; requested_by: string | null; is_test: boolean;
}

/** The insert, or null when the pull has no dealer rows (an empty pull is not staged: the caller reports it as the failure it is). */
export function stagingRow(o: { company: string; entries: readonly PriceListEntry[]; routeOrigin: string; requestedBy?: unknown; level?: string }): StagingInsert | null {
  const level = o.level ?? "DEALER";
  const rates = stagedRates(o.entries, level);
  if (rates.length === 0) return null;
  const origin = originOf(o.routeOrigin);
  return {
    company: o.company, price_level: level, origin, rates,
    // A scheduled pull has no asker by definition; never attach one.
    requested_by: origin === "daily" ? null : requesterFrom(o.requestedBy),
    is_test: /^ZZ TEST/.test(o.company),
  };
}

interface InsertClient { from(table: string): { insert(row: unknown): { select(cols: string): PromiseLike<{ data: unknown; error: { message: string } | null }> } } }

/** One INSERT into staging; returns the new id. Every error throws, so the caller never reports a pull staged that was not. */
export async function writePull(client: InsertClient, row: StagingInsert): Promise<number> {
  const { data, error } = await client.from(STAGING_TABLE).insert(row).select("id");
  if (error) throw new Error(`price pull staging: ${error.message}`);
  const id = Number((data as Array<{ id: unknown }> | null)?.[0]?.id);
  if (!Number.isFinite(id)) throw new Error("price pull staging: the insert returned no id");
  return id;
}

interface ReadClient {
  from(table: string): {
    select(cols: string): { eq(col: string, v: unknown): any };
  };
}

/** A staged pull row turned back into list entries. Null when a row cannot be read as one (never a half pull). */
export function entriesFromStaged(rates: unknown): PriceListEntry[] | null {
  if (!Array.isArray(rates) || rates.length === 0) return null;
  const out: PriceListEntry[] = [];
  for (const r of rates as Array<Record<string, unknown>>) {
    const itemName = typeof r.item_name === "string" ? r.item_name : "";
    const rate = Number(r.rate);
    const level = typeof r.price_level === "string" ? r.price_level : "";
    if (!itemName || !Number.isFinite(rate) || !level) return null;
    out.push({
      itemName, priceLevel: level, priceLevelRaw: typeof r.price_level_raw === "string" ? r.price_level_raw : level,
      date: typeof r.effective_from === "string" ? r.effective_from.slice(0, 10) : "", rate,
      unit: typeof r.unit === "string" ? r.unit : "", discountPct: Number.isFinite(Number(r.discount_pct)) ? Number(r.discount_pct) : 0,
    });
  }
  return out;
}

/**
 * Copy the newest ACCEPTED pull for the company into the list in force, if it is newer than `lastAppliedId`. Returns the id applied, or null when
 * there is nothing newer. The copy is `apply(entries, company, origin)`, the same call a direct pull makes, so the list, the change log and the
 * dealer prices behave exactly as before. Reading is by (pulled_at, id) newest first, the order the database uses for "newer".
 */
export async function applyAccepted(o: {
  client: ReadClient; company: string; lastAppliedId: number; level?: string;
  apply: (entries: PriceListEntry[], company: string, origin: string) => Promise<void>;
}): Promise<number | null> {
  const res = await o.client.from(STAGING_TABLE).select("id, rates, pulled_at")
    .eq("company", o.company).eq("price_level", o.level ?? "DEALER").eq("status", "accepted")
    .order("pulled_at", { ascending: false }).order("id", { ascending: false }).limit(1);
  if (res.error) throw new Error(`price pull staging: ${res.error.message}`);
  const row = (res.data ?? [])[0] as { id: unknown; rates: unknown } | undefined;
  if (!row) return null;
  const id = Number(row.id);
  if (!Number.isFinite(id) || id <= o.lastAppliedId) return null;
  const entries = entriesFromStaged(row.rates);
  if (!entries) throw new Error(`price pull staging: accepted pull ${id} cannot be read as a price list; not copied`);
  await o.apply(entries, o.company, "accepted-pull");
  return id;
}
