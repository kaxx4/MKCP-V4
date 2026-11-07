/**
 * JOB: fill the masters of the go-live swap store (D-1-5.58 option C; reports/1-5.md "what is not filled"):
 * ledger details, stock items, stock groups, GST rates and the company row, as the rows of tally_ledgers,
 * tally_stock_items, tally_stock_groups, tally_gst_rates and tally_companies, written to erp_tally_rows through
 * erp_tally_put and erp_tally_finish (migrations 0125, 0128, 0136).
 *
 * One definition: the rows are built by the SAME mappers today's masters sync uses (`mapLedger`, `mapStockItem`,
 * `mapStockGroup` in supabaseSync.ts, `gstRateRow`), after the same converters, so the swap store cannot drift from
 * tally_*. Parity (erp_tally_parity) compares the two.
 *
 * How it reads, and why (the Tally port is never risked):
 *  - ONE request at a time, each with a limit of 120 s or less, no retry. The old masters read asked for every ledger
 *    field in one request with a 900 s limit. Here the ledger read is SPLIT BY FIELD: a base read (name, group, opening
 *    balance, credit periods) and then each detail field alone (GSTIN, registration block, mailing name, address, state,
 *    country, pincode, e-mail, phone), the same way thread 7 probed the contact fields one at a time. The pieces are
 *    merged by GUID. Stock items are split the same way (base, opening values, closing values, GST and HSN details).
 *  - A piece that returns a different number of records from the base piece fails the whole run (G7: a short reply is
 *    never "fewer records"). A request that errors or times out fails the run; nothing is retried.
 *  - Nothing is written until EVERY read has succeeded, so a failed run leaves the store as it was. Each table is then
 *    put in chunks and finished (the database refuses a miscounted run, an empty run, or one under 80 percent of what
 *    the table held).
 *  - Test runs (the dummy): every ledger name is a keyed stand-in and every personal field (GSTIN, mailing name,
 *    address, phone, e-mail, pincode) is null; the company row carries the test company key.
 *
 * Never here: a write to a tally_* table, a dated read, a wildcard fetch field.
 */
import type { CollectionDef } from "../types.js";
import { buildCollectionXml } from "./xmlBuilder.js";
import { convertLedgers, convertStockGroups, convertStockItems } from "../converters/convert.js";
import { SupabaseSync, gstRateRow } from "./supabaseSync.js";
import { fetchGstRates } from "./tallyGstRates.js";
import { stageChunks } from "./stageChunks.js";

/** The longest any single Tally request here may take. */
export const MASTERS_READ_LIMIT_MS = 120_000;

const piece = (name: string, tallyCollection: "Ledger" | "StockItem" | "StockGroup", fetch: string[]): CollectionDef => ({
  name, tallyCollection, metadataType: tallyCollection, category: "master", fetch, timeout: MASTERS_READ_LIMIT_MS, parallel: false,
});

/** Ledgers: the cheap base, then one detail field per request. Every piece names GUID and Name so the pieces can be merged. */
export const LEDGER_PIECES: CollectionDef[] = [
  piece("ledgerBase", "Ledger", ["GUID", "Name", "Parent", "OpeningBalance", "CreditPeriod", "BillCreditPeriod"]),
  ...["PartyGSTIN", "LedGSTRegDetails", "MailingName", "Address", "LedStateName", "CountryName", "PinCode", "Email", "LedgerPhone"]
    .map((f) => piece(`ledger_${f}`, "Ledger", ["GUID", "Name", f])),
];

/** Stock items: base, opening values, closing values, GST and HSN details. */
export const ITEM_PIECES: CollectionDef[] = [
  piece("itemBase", "StockItem", ["GUID", "Name", "Parent", "Category", "BaseUnits", "AdditionalUnits", "Denominator", "CostingMethod", "ValuationMethod",
    "IsBatchWiseOn", "IsCostCentresOn", "GSTApplicable", "GSTTypeOfSupply"]),
  piece("itemOpening", "StockItem", ["GUID", "Name", "OpeningBalance", "OpeningRate", "OpeningValue"]),
  piece("itemClosing", "StockItem", ["GUID", "Name", "ClosingBalance", "ClosingRate", "ClosingValue"]),
  piece("itemGst", "StockItem", ["GUID", "Name", "GSTDetails", "HSNDetails"]),
];

export const GROUP_PIECE: CollectionDef = piece("stockGroups", "StockGroup", ["GUID", "Name", "Parent", "IsAddable"]);

export type MastersPost = (xml: string, timeoutMs: number) => Promise<any>;

const text = (x: any): string => {
  if (x === null || x === undefined) return "";
  if (typeof x === "object") return String(x["#text"] ?? "").trim();
  return String(x).trim();
};
const asArray = (x: any): any[] => (x === undefined || x === null ? [] : Array.isArray(x) ? x : [x]);
const dig = (o: any, ...path: string[]) => path.reduce((a, k) => (a === undefined || a === null ? undefined : a[k]), o);

/** The records of a parsed collection reply, in the order Tally sent them. */
export function recordsOf(parsed: any, tag: string): any[] {
  const col = dig(parsed, "ENVELOPE", "BODY", "DATA", "COLLECTION") ?? dig(parsed, "ENVELOPE", "BODY", "DATA", "TALLYMESSAGE");
  return asArray(col?.[tag] ?? col?.[`${tag}.LIST`]);
}

const idOf = (rec: any): string => text(rec?.GUID) || String(rec?.["@_NAME"] ?? text(rec?.NAME));

/**
 * Merge the replies of several field-split reads of the same records by GUID. Every piece must carry exactly the
 * records the first piece carried (same count, same ids); otherwise it throws, and nothing is built from a half-read.
 */
export function mergePieces(parsedPieces: any[], tag: string, what: string): any {
  if (!parsedPieces.length) throw new Error(`${what}: no read to merge`);
  const base = recordsOf(parsedPieces[0], tag);
  const order = base.map(idOf);
  if (new Set(order).size !== order.length) throw new Error(`${what}: two records share one GUID or name in the base read, so they cannot be merged safely`);
  const merged = new Map<string, any>(base.map((r, i) => [order[i], { ...r }]));
  parsedPieces.slice(1).forEach((p, n) => {
    const recs = recordsOf(p, tag);
    if (recs.length !== base.length) throw new Error(`${what}: read ${n + 2} returned ${recs.length} records but the base read returned ${base.length}; a short reply is not "fewer records", so the run fails and nothing is written`);
    for (const r of recs) {
      const id = idOf(r);
      const into = merged.get(id);
      if (!into) throw new Error(`${what}: read ${n + 2} returned a record the base read did not (${id.slice(0, 8)}...), so the run fails and nothing is written`);
      Object.assign(into, r);
    }
  });
  return { ENVELOPE: { BODY: { DATA: { COLLECTION: { [tag]: order.map((id) => merged.get(id)) } } } } };
}

export interface MasterRow { key: string; row: Record<string, unknown> }
export type MasterTable = "tally_companies" | "tally_stock_groups" | "tally_stock_items" | "tally_ledgers" | "tally_gst_rates";
export const MASTER_TABLES: readonly MasterTable[] = ["tally_companies", "tally_stock_groups", "tally_stock_items", "tally_ledgers", "tally_gst_rates"];

/** Columns of a ledger row that name or locate a person or a registration: null on every test row. */
export const PERSONAL_LEDGER_COLUMNS = ["gstin", "mailing_name", "address", "phone", "email", "pincode"] as const;

const mapper = (): any => Object.create(SupabaseSync.prototype);
const stripStamp = (r: Record<string, any>): Record<string, unknown> => { const { synced_at: _s, ...rest } = r; return rest; };

export interface MastersOpts {
  /** The company key rows are stored under (the `company` column; the company row's `name`). */
  company: string;
  test: boolean;
  /** A keyed stand-in for a name (test runs only). */
  name?: (kind: string, s: string) => string | null;
}

/** Pure: the ledger messages from the converter to tally_ledgers rows, keyed by GUID. */
export function ledgerRows(messages: any[], o: MastersOpts): MasterRow[] {
  const out: MasterRow[] = [];
  for (const m of messages) {
    const mapped = mapper().mapLedger(m, o.company);
    if (!mapped) continue;
    const row = stripStamp(mapped);
    if (o.test) {
      for (const c of PERSONAL_LEDGER_COLUMNS) row[c] = null;
      row.name = o.name ? o.name("LEDGER", String(mapped.name ?? "")) : null;
    }
    out.push({ key: String(row.guid), row });
  }
  return out;
}

export function itemRows(messages: any[], o: MastersOpts): MasterRow[] {
  const out: MasterRow[] = [];
  for (const m of messages) {
    const mapped = mapper().mapStockItem(m, o.company);
    if (mapped) out.push({ key: String(mapped.guid), row: stripStamp(mapped) });
  }
  return out;
}

export function groupRows(messages: any[], o: MastersOpts): MasterRow[] {
  const out: MasterRow[] = [];
  for (const m of messages) {
    const mapped = mapper().mapStockGroup(m, o.company);
    if (mapped) out.push({ key: String(mapped.guid), row: stripStamp(mapped) });
  }
  return out;
}

export function gstRows(entries: Parameters<typeof gstRateRow>[0][], o: MastersOpts): MasterRow[] {
  return entries.map((e) => {
    const row = gstRateRow(e, o.company);
    return { key: `${row.scope}|${row.name}|${row.effective_from}`, row };
  });
}

export const companyRows = (o: MastersOpts): MasterRow[] => [{ key: o.company, row: { name: o.company } }];

/** Refuses duplicate keys (a put with one key twice would fail in the database; here it fails with a name). */
export function assertUniqueKeys(table: string, rows: MasterRow[]): void {
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.key)) throw new Error(`${table}: two rows share the key ${r.key.slice(0, 12)}...; refusing to write`);
    seen.add(r.key);
  }
}

/** The database half. put and finish are the ERP functions of migrations 0125 and 0136; every error throws. */
export interface MastersStore {
  put(table: MasterTable, marker: string, rows: MasterRow[]): Promise<number>;
  finish(table: MasterTable, marker: string, expected: number): Promise<Record<string, unknown>>;
}

export function supabaseMastersStore(c: { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: any; error: { message: string } | null }> },
  machine: string, key: string, companyKey: string, isTest: boolean): MastersStore {
  const call = async (fn: string, args: Record<string, unknown>) => {
    const { data, error } = await c.rpc(fn, { p_machine: machine, p_key: key, p_company_key: companyKey, p_is_test: isTest, ...args });
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data;
  };
  return {
    async put(table, marker, rows) { return Number(await call("erp_tally_put", { p_table: table, p_marker: marker, p_rows: rows })); },
    async finish(table, marker, expected) { return (await call("erp_tally_finish", { p_table: table, p_marker: marker, p_expected: expected })) as Record<string, unknown>; },
  };
}

export interface MastersReport {
  ok: boolean;
  error: string | null;
  /** Every Tally request in order: what, how long, how many records. */
  reads: { name: string; ms: number; records: number }[];
  rows: Partial<Record<MasterTable, number>>;
  finished: Partial<Record<MasterTable, Record<string, unknown>>>;
  largestPutRows: number;
  largestPutBytes: number;
  tallyRequests: number;
}

/**
 * One run. All reads first (one at a time), then, only if all succeeded, put and finish each table.
 * `post` sends one request and resolves to the parsed reply; it is the only thing that touches Tally.
 */
export async function runMasters(opts: {
  post: MastersPost;
  fetchGst: () => Promise<Parameters<typeof gstRateRow>[0][]>;
  store: MastersStore;
  mastersOpts: MastersOpts;
  company: string;
  newMarker: () => string;
  log?: (l: string) => void;
}): Promise<MastersReport> {
  const log = opts.log ?? ((l: string) => console.log(`[erpMasters] ${l}`));
  const rep: MastersReport = { ok: false, error: null, reads: [], rows: {}, finished: {}, largestPutRows: 0, largestPutBytes: 0, tallyRequests: 0 };
  const read = async (def: CollectionDef): Promise<any> => {
    if (def.timeout > MASTERS_READ_LIMIT_MS) throw new Error(`refused: ${def.name} has a limit of ${def.timeout} ms, over ${MASTERS_READ_LIMIT_MS}`);
    const t0 = Date.now();
    rep.tallyRequests += 1;
    const parsed = await opts.post(buildCollectionXml(def, opts.company), def.timeout);   // no retry: a request that fails fails the run
    const recs = recordsOf(parsed, def.tallyCollection === "StockItem" ? "STOCKITEM" : def.tallyCollection === "StockGroup" ? "STOCKGROUP" : "LEDGER");
    rep.reads.push({ name: def.name, ms: Date.now() - t0, records: recs.length });
    log(`${def.name}: ${recs.length} records in ${Date.now() - t0} ms`);
    return parsed;
  };
  try {
    const groups = await read(GROUP_PIECE);
    const ledgerParts: any[] = [];
    for (const d of LEDGER_PIECES) ledgerParts.push(await read(d));
    const itemParts: any[] = [];
    for (const d of ITEM_PIECES) itemParts.push(await read(d));
    const gst = await opts.fetchGst();
    rep.tallyRequests += 2;
    const o = opts.mastersOpts;
    const tables: Record<MasterTable, MasterRow[]> = {
      tally_companies: companyRows(o),
      tally_stock_groups: groupRows(convertStockGroups(groups).tallymessage, o),
      tally_stock_items: itemRows(convertStockItems(mergePieces(itemParts, "STOCKITEM", "stock items")).tallymessage, o),
      tally_ledgers: ledgerRows(convertLedgers(mergePieces(ledgerParts, "LEDGER", "ledgers")).tallymessage, o),
      tally_gst_rates: gstRows(gst, o),
    };
    for (const t of MASTER_TABLES) assertUniqueKeys(t, tables[t]);
    for (const t of ["tally_ledgers", "tally_stock_items", "tally_stock_groups"] as const) {
      if (tables[t].length === 0) throw new Error(`${t}: Tally returned no usable record, so nothing is written (an empty reply is never read as nothing there)`);
    }
    // every read succeeded: now, and only now, write
    for (const t of MASTER_TABLES) {
      const rows = tables[t];
      const marker = opts.newMarker();
      for (const part of stageChunks(rows, 1000, 1_500_000)) {
        await opts.store.put(t, marker, part);
        rep.largestPutRows = Math.max(rep.largestPutRows, part.length);
        rep.largestPutBytes = Math.max(rep.largestPutBytes, Buffer.byteLength(JSON.stringify(part), "utf8"));
      }
      rep.finished[t] = await opts.store.finish(t, marker, rows.length);
      rep.rows[t] = rows.length;
      log(`${t}: ${rows.length} rows written and finished`);
    }
    rep.ok = true;
  } catch (e) {
    rep.error = e instanceof Error ? e.message : String(e);
    log(`failed: ${rep.error}`);
  }
  return rep;
}

/** The GST read with every request held to the masters limit. */
export const fetchGstWithinLimit = (tallyUrl: string, company: string) =>
  fetchGstRates(tallyUrl, company, { itemsMs: MASTERS_READ_LIMIT_MS, groupsMs: MASTERS_READ_LIMIT_MS });
