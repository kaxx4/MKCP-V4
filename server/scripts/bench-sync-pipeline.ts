/**
 * BENCH (speed pass S3, 28-Nov-2026): time one "Sync now, today" pipeline end to end with a FAKE Tally and a FAKE Supabase.
 *
 * What it answers: how long does the agent's own part of a sync take, and how many database requests does it make? Tally's own time (the scan
 * of every voucher, about 14 to 22 s on the office machine for a one-day read, from tally_sync_history) is NOT in these numbers: the fake
 * Tally answers at once, so what is measured is what the agent controls. Run it twice, once against the old code and once against the new,
 * with the same data and the same fake delay per database request:
 *
 *   npx tsx scripts/bench-sync-pipeline.ts                       # this tree
 *   BENCH_SRC=/path/to/other/server/src npx tsx scripts/bench-sync-pipeline.ts
 *   BENCH_DB_MS=200 BENCH_PRICE_ROWS=4276 npx tsx scripts/bench-sync-pipeline.ts
 *
 * Never touches Tally or Supabase: the Tally post is the mock transport, the database client is an in-memory fake with a fixed delay per request.
 * The masters answers are replayed from server/fixtures (captured Tally replies), the price list, GST rates and the day's vouchers are made up.
 * The first pass fills the fake database, so the measured second pass is the usual steady state: nothing in Tally has changed since the last pull.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

const HERE = __dirname;
const SRC = path.resolve(process.env.BENCH_SRC ?? path.join(HERE, "..", "src"));
const DB_MS = Number(process.env.BENCH_DB_MS ?? 200);
const PRICE_ROWS = Number(process.env.BENCH_PRICE_ROWS ?? 4276);
const VOUCHERS = Number(process.env.BENCH_VOUCHERS ?? 31);
/** How long the fake Tally takes over the day's voucher read. 0 by default; set it (say 3000) to see the database half overlap a real wait. */
const TALLY_VOUCHER_MS = Number(process.env.BENCH_TALLY_VOUCHER_MS ?? 0);
const FIXTURES = path.join(HERE, "..", "fixtures");

// An env the fake client can run under: a key so SupabaseSync builds a client (replaced below), role primary (the default).
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "bench-not-a-key";
process.env.SUPABASE_URL = "http://127.0.0.1:9";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const imp = (rel: string) => import(pathToFileURL(path.join(SRC, rel)).href);

// ── the fake database ────────────────────────────────────────────────────────
type Row = Record<string, any>;
const stats = { requests: 0, byTable: new Map<string, number>(), rowsWritten: new Map<string, number>(), upserts: 0 };
const tables = new Map<string, Map<string, Row>>();
const CONFLICT_DEFAULT = "guid";

function keyOf(row: Row, conflict: string): string { return conflict.split(",").map((c) => String(row[c.trim()])).join("|"); }

class Q {
  private op: "select" | "upsert" | "insert" | "delete" = "select";
  private filters: Array<(r: Row) => boolean> = [];
  private payload: Row[] = [];
  private conflict = CONFLICT_DEFAULT;
  private wantCount = false;
  private lo = 0;
  private hi = Infinity;
  constructor(private table: string) {}
  select(_cols?: string, o?: { count?: string; head?: boolean }) { this.op = this.op === "select" ? "select" : this.op; this.wantCount = o?.count === "exact"; return this; }
  eq(c: string, v: unknown) { this.filters.push((r) => String(r[c]) === String(v)); return this; }
  in(c: string, v: unknown[]) { const s = new Set(v.map(String)); this.filters.push((r) => s.has(String(r[c]))); return this; }
  gte() { return this; } lte() { return this; } lt() { return this; } gt() { return this; } neq() { return this; } is() { return this; } not() { return this; }
  order() { return this; }
  limit(n: number) { this.hi = Math.min(this.hi, n - 1); return this; }
  range(a: number, b: number) { this.lo = a; this.hi = b; return this; }
  single() { return this.then((x: any) => ({ data: (x.data ?? [])[0] ?? null, error: null })); }
  maybeSingle() { return this.single(); }
  upsert(rows: Row | Row[], o?: { onConflict?: string }) { this.op = "upsert"; this.payload = Array.isArray(rows) ? rows : [rows]; this.conflict = o?.onConflict ?? CONFLICT_DEFAULT; return this; }
  insert(rows: Row | Row[]) { this.op = "insert"; this.payload = Array.isArray(rows) ? rows : [rows]; return this; }
  delete() { this.op = "delete"; return this; }
  update() { this.op = "insert"; this.payload = []; return this; }
  async exec(): Promise<any> {
    await sleep(DB_MS);
    stats.requests++;
    stats.byTable.set(this.table, (stats.byTable.get(this.table) ?? 0) + 1);
    const t = tables.get(this.table) ?? new Map<string, Row>();
    tables.set(this.table, t);
    if (this.op === "upsert") {
      stats.upserts++;
      for (const r of this.payload) t.set(keyOf(r, this.conflict), { ...(t.get(keyOf(r, this.conflict)) ?? {}), ...r });
      stats.rowsWritten.set(this.table, (stats.rowsWritten.get(this.table) ?? 0) + this.payload.length);
      return { data: null, error: null };
    }
    if (this.op === "insert") {
      let i = t.size;
      for (const r of this.payload) t.set(`ins${i++}`, r);
      stats.rowsWritten.set(this.table, (stats.rowsWritten.get(this.table) ?? 0) + this.payload.length);
      return { data: null, error: null };
    }
    if (this.op === "delete") return { data: null, error: null };
    const all = [...t.values()].filter((r) => this.filters.every((f) => f(r)));
    return { data: all.slice(this.lo, Math.min(all.length, this.hi + 1)), error: null, count: this.wantCount ? all.length : null };
  }
  then(res: (v: any) => any, rej?: (e: any) => any) { return this.exec().then(res, rej); }
}

function fakeClient(db: Map<string, Map<string, Row>>) {
  return {
    from: (table: string) => new Q(table),
    rpc: async (name: string, args: any) => {
      await sleep(DB_MS);
      stats.requests++;
      stats.byTable.set(`rpc:${name}`, (stats.byTable.get(`rpc:${name}`) ?? 0) + 1);
      if (name === "replace_voucher_children") {
        const lt = db.get("tally_voucher_ledger_entries") ?? new Map(); db.set("tally_voucher_ledger_entries", lt);
        for (const g of args.p_guids as string[]) for (const k of [...lt.keys()]) if (lt.get(k)!.voucher_guid === g) lt.delete(k);
        (args.p_ledger as Row[]).forEach((r, i) => lt.set(`${r.voucher_guid}|${i}`, r));
        stats.rowsWritten.set("children", (stats.rowsWritten.get("children") ?? 0) + (args.p_ledger.length + args.p_inventory.length));
        return { data: { ledger: args.p_ledger.length, inventory: args.p_inventory.length }, error: null };
      }
      return { data: 0, error: null };
    },
    channel: () => ({ on() { return this; }, subscribe() { return this; } }),
    removeChannel: async () => undefined,
  };
}

// ── the fake Tally ───────────────────────────────────────────────────────────
function tallyReply(fx: any, priceXml: string, gstItemsXml: string, gstGroupsXml: string) {
  return async (_url: string, xml: string): Promise<string> => {
    const id = xml.match(/<ID[^>]*>([^<]+)<\/ID>/i)?.[1]?.trim() ?? "";
    if (id === "MkPriceList") return priceXml;
    if (id === "MkGstItems") return gstItemsXml;
    if (id === "MkGstGroups") return gstGroupsXml;
    const f = fx.get(id);
    if (f) return f.responseXml;
    throw new Error(`bench: no fake answer for request "${id}"`);
  };
}

function priceXmlOf(rows: number): string {
  const per = 8; // dated entries per item, like the live catalogue (4,276 rows over ~510 items)
  const items = Math.ceil(rows / per);
  let out = "<ENVELOPE><BODY><DATA><COLLECTION>";
  let n = 0;
  for (let i = 0; i < items && n < rows; i++) {
    out += `<STOCKITEM NAME="BENCH ITEM ${i}" RESERVEDNAME="">`;
    for (let k = 0; k < per && n < rows; k++, n++) {
      const y = 2018 + k;
      out += `<FULLPRICELIST.LIST><DATE>${y}0401</DATE><PRICELEVEL>Dealer</PRICELEVEL><PRICELEVELLIST.LIST><RATE>${(100 + i + k * 3).toFixed(2)}/PC</RATE><DISCOUNT>0</DISCOUNT></PRICELEVELLIST.LIST></FULLPRICELIST.LIST>`;
    }
    out += "</STOCKITEM>";
  }
  return out + "</COLLECTION></DATA></BODY></ENVELOPE>";
}

function gstXmlOf(type: "STOCKITEM" | "STOCKGROUP", count: number): string {
  let out = "<ENVELOPE><BODY><DATA><COLLECTION>";
  for (let i = 0; i < count; i++) {
    out += `<${type} NAME="BENCH ${type} ${i}"><NAME>BENCH ${type} ${i}</NAME><PARENT>BENCH GROUP</PARENT>` +
      `<GSTDETAILS.LIST><APPLICABLEFROM>20250922</APPLICABLEFROM><TAXABILITY>Taxable</TAXABILITY><SRCOFGSTDETAILS>Specify Details Here</SRCOFGSTDETAILS>` +
      `<STATEWISEDETAILS.LIST><RATEDETAILS.LIST><GSTRATEDUTYHEAD>CGST</GSTRATEDUTYHEAD><GSTRATE> 2.5</GSTRATE></RATEDETAILS.LIST>` +
      `<RATEDETAILS.LIST><GSTRATEDUTYHEAD>SGST/UTGST</GSTRATEDUTYHEAD><GSTRATE> 2.5</GSTRATE></RATEDETAILS.LIST>` +
      `<RATEDETAILS.LIST><GSTRATEDUTYHEAD>IGST</GSTRATEDUTYHEAD><GSTRATE> 5</GSTRATE></RATEDETAILS.LIST></STATEWISEDETAILS.LIST></GSTDETAILS.LIST></${type}>`;
  }
  return out + "</COLLECTION></DATA></BODY></ENVELOPE>";
}

function dayReply(day: string, n: number) {
  const msgs = [];
  for (let i = 0; i < n; i++) {
    msgs.push({ VOUCHER: {
      GUID: `bench-guid-${i}`, DATE: day, VOUCHERTYPENAME: "Sales", VOUCHERNUMBER: `B/${i}`, PARTYLEDGERNAME: "BENCH PARTY", ALTERID: String(1000 + i), MASTERID: String(i),
      "ALLLEDGERENTRIES.LIST": [{ LEDGERNAME: "BENCH PARTY", AMOUNT: "-1180.00", ISDEEMEDPOSITIVE: "Yes" }, { LEDGERNAME: "SALES", AMOUNT: "1000.00" }, { LEDGERNAME: "IGST", AMOUNT: "180.00" }],
      "ALLINVENTORYENTRIES.LIST": [{ STOCKITEMNAME: "BENCH ITEM 1", RATE: "100.00/PC", AMOUNT: "1000.00", BILLEDQTY: "10 PC", ACTUALQTY: "10 PC" }],
    } });
  }
  return { ENVELOPE: { BODY: { DATA: { TALLYMESSAGE: msgs } } } };
}

const ymd = (d: Date) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;

async function main() {
  const { SyncOrchestrator } = await imp("services/syncOrchestrator.ts");
  const { installMock, FixtureStore } = await imp("services/tallyMock.ts");
  const fx = new FixtureStore(FIXTURES);
  const itemsPerGroup = Math.max(50, Math.round(PRICE_ROWS / 36));
  installMock(tallyReply(fx, priceXmlOf(PRICE_ROWS), gstXmlOf("STOCKITEM", itemsPerGroup), gstXmlOf("STOCKGROUP", 20)));

  const orch: any = new SyncOrchestrator("http://127.0.0.1:0", {} as any);
  const today = ymd(new Date());
  orch.post = async () => { if (TALLY_VOUCHER_MS) await sleep(TALLY_VOUCHER_MS); return dayReply(today, VOUCHERS); };   // the voucher read seam (a fake Tally answer)
  const sb: any = orch.supabase;
  sb.client = fakeClient(tables);
  if (!sb.client) throw new Error("no client");

  const quiet = console.log;
  const run = async (label: string) => {
    stats.requests = 0; stats.byTable.clear(); stats.rowsWritten.clear(); stats.upserts = 0;
    const t0 = Date.now();
    console.log = () => undefined;
    let res: any;
    try {
      res = await orch.syncAll({ company: "BENCH CO", fromDate: today, toDate: today, mode: "full", chunkStrategy: "daily", selective: false, signal: new AbortController().signal }, () => undefined);
    } finally { console.log = quiet; }
    const ms = Date.now() - t0;
    const w = [...stats.rowsWritten.entries()].filter(([t]) => /price_list|gst_rates|stock_items|ledgers/.test(t)).map(([t, n]) => `${t.replace("tally_", "")}=${n}`).join(" ");
    console.log(`${label.padEnd(26)} ${String(ms).padStart(6)} ms   ${String(stats.requests).padStart(3)} database requests   rows written: ${w || "none"}   ok=${res?.success}`);
    if (process.env.BENCH_DETAIL) console.log("   requests by table: " + [...stats.byTable.entries()].map(([t, n]) => `${t}=${n}`).join(" "));
    return { ms, requests: stats.requests };
  };

  console.log(`fake database: ${DB_MS} ms per request, ${PRICE_ROWS} price rows, ${VOUCHERS} vouchers today; Tally answers ${TALLY_VOUCHER_MS ? `the day read in ${TALLY_VOUCHER_MS} ms, the rest at once` : 'instantly'} (its real time is not measured here)`);
  await run("first pass (fills the db)");
  const a = await run("steady state, pass 2");
  const b = await run("steady state, pass 3");
  console.log(`RESULT steady state: ${Math.round((a.ms + b.ms) / 2)} ms, ${Math.round((a.requests + b.requests) / 2)} requests`);
}

main().catch((e) => { console.error("BENCH FAILED:", e?.stack || e); process.exit(1); });
