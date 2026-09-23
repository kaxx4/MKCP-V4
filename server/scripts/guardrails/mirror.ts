/**
 * Read-only access to the Supabase mirror for the guardrail runner.
 *
 * `supabaseClient()` deliberately returns null on a sandbox machine (tallyRole),
 * which is right for anything that WRITES. This runner only ever SELECTs, so it
 * builds its own client the way check-mirror-truth.ts does — and exposes no
 * write helper at all. The one permitted write (requesting an office report via
 * tally_report_jobs) lives in pull.ts behind an explicit flag.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { TallyMasters, MasterItem, MasterStockGroup, MasterLedger, GstRevision } from "../../src/services/tallyMasters.js";

export const COMPANY_KEY = "M.K.CYCLES (P) LTD. - (from 1-Apr-26)";

export function mirrorClient(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

/** Every row of a table for the company, paged (PostgREST caps a page at 1,000). */
export async function allRows<T = Record<string, unknown>>(sb: SupabaseClient, table: string, columns: string, filter?: (q: any) => any): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from(table).select(columns).eq("company", COMPANY_KEY).range(from, from + 999);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

const clean = (s: unknown) => String(s ?? "").replace(/&#4;/g, "").replace(/[\x00-\x08]/g, "").trim();

/**
 * A TallyMasters rebuilt from the mirror — Tally's own data, one hop removed.
 * GST revisions come from `tally_gst_rates` (dated, IGST combined), the table
 * the sync writes from Tally's GSTDETAILS blocks.
 */
export async function mastersFromMirror(sb: SupabaseClient): Promise<TallyMasters> {
  const [ledgerRows, itemRows, groupRows, rateRows] = await Promise.all([
    allRows<any>(sb, "tally_ledgers", "guid,name,parent,gstin,state,pincode,mailing_name,address"),
    allRows<any>(sb, "tally_stock_items", "guid,name,parent,base_units"),
    allRows<any>(sb, "tally_stock_groups", "name,parent"),
    allRows<any>(sb, "tally_gst_rates", "scope,name,effective_from,gst_rate,cgst_rate,sgst_rate,igst_rate,taxability,parent"),
  ]);
  const revs = new Map<string, GstRevision[]>();
  for (const r of rateRows) {
    const k = `${r.scope}|${r.name}`;
    const igst = Number(r.igst_rate) || 0, cgst = Number(r.cgst_rate) || 0, sgst = Number(r.sgst_rate) || 0;
    (revs.get(k) ?? revs.set(k, []).get(k)!).push({ from: String(r.effective_from ?? "").slice(0, 10), rate: igst || cgst + sgst, cgst, sgst, igst, taxability: r.taxability ?? "" });
  }
  for (const v of revs.values()) v.sort((a, b) => a.from.localeCompare(b.from));
  const ledgers = new Map<string, MasterLedger>();
  for (const l of ledgerRows) {
    const address = Array.isArray(l.address) ? l.address.map(String) : l.address ? String(l.address).split(/\r?\n/).filter(Boolean) : [];
    ledgers.set(l.name, { name: l.name, parent: clean(l.parent), gstin: clean(l.gstin), state: clean(l.state), pincode: clean(l.pincode),
      mailingName: clean(l.mailing_name), address, registrations: [] } as unknown as MasterLedger);
  }
  const groups = new Map<string, MasterStockGroup>();
  for (const g of groupRows) {
    const gr = revs.get(`stock_group|${g.name}`) ?? [];
    groups.set(g.name, { name: g.name, parent: clean(g.parent).replace(/^Primary$/, ""), gstRate: 0, cgstRate: 0, sgstRate: 0, igstRate: 0, gstRevisions: gr } as MasterStockGroup);
  }
  const items = new Map<string, MasterItem>();
  for (const i of itemRows) {
    // Phantom rows (name as guid, every column null) must not shadow the real one.
    if (items.has(i.name) && !/^[0-9a-f]{8}-/i.test(String(i.guid))) continue;
    items.set(i.name, { name: i.name, parent: clean(i.parent), baseUnit: clean(i.base_units), denominator: 1, closingRate: 0, closingStock: 0,
      gstRate: 0, cgstRate: 0, sgstRate: 0, igstRate: 0, gstRevisions: revs.get(`item|${i.name}`) ?? [], gstRateSource: "" } as unknown as MasterItem);
  }
  const loose = (s: string) => s.replace(/\s+/g, " ").trim().toUpperCase();
  return {
    company: COMPANY_KEY, loadedAt: Date.now(), ledgers, items, stockGroups: groups,
    godowns: new Set(["Main Location"]), units: new Set([...items.values()].map((i) => i.baseUnit)),
    voucherTypes: new Set(["SALES", "Purchase", "Payment", "Receipt", "Contra", "Journal", "Credit Note", "Debit Note", "Sales Order Note", "Receipt Note"]),
    ledgerLoose: new Map([...ledgers.keys()].map((n) => [loose(n), n])),
    itemLoose: new Map([...items.keys()].map((n) => [loose(n), n])),
  } as unknown as TallyMasters;
}
