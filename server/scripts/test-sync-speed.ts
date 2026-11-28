/**
 * Offline proof for the sync speed pass (S3, 28-Nov-2026). No Tally, no Supabase, no clock beyond short real timers.
 *
 *   1. "Sync now" starts after 1.5 s, not 8 s, and a busy port is looked at again after 2 s (refreshListener.ts constants).
 *   2. The price list and GST rates write only the rows that differ (plus one freshness row), and an unchanged pull does not announce itself.
 *   3. The GST comparison no longer calls every row changed (the stored side had no `company`, so ~114 rows read as changed on every pass).
 *   4. The masters upload runs beside the day's Tally read, and "done" still waits for it (syncOrchestrator.syncAll).
 *   5. A new-job signal wakes the queue loop at once; a failure's back-off is never shortened (primaryRunner.ts, queueWake.ts).
 *   6. mapLimit keeps order, honours its limit and rejects like Promise.all.
 *
 *   npx tsx scripts/test-sync-speed.ts
 */
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "test-not-a-key";
process.env.SUPABASE_URL = "http://127.0.0.1:9";

import { COALESCE_MS, BUSY_RETRY_MS, MAX_BUSY_RETRIES } from "../src/services/refreshListener.js";
import { diffMasterRows, withFreshnessStamp, mapLimit } from "../src/services/masterDiff.js";
import { gstRateRow, SupabaseSync } from "../src/services/supabaseSync.js";
import { SyncOrchestrator } from "../src/services/syncOrchestrator.js";
import { PrimaryQueueLoop, WAKE_RECHECK_MS, WAKE_MIN_GAP_MS } from "../src/services/primaryRunner.js";
import { isJobSignal, startQueueWake, JOB_SIGNAL_TABLE } from "../src/services/queueWake.js";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const log = console.log, warn = console.warn, err = console.error;
  console.log = () => undefined; console.warn = () => undefined; console.error = () => undefined;
  try { return await fn(); } finally { console.log = log; console.warn = warn; console.error = err; }
};

// ── 1. the waits ─────────────────────────────────────────────────────────────
function testWaits() {
  console.log("\n1. waits before a sync starts");
  ok("a click starts the sync within 2 s (was 8 s)", COALESCE_MS <= 2_000, `${COALESCE_MS} ms`);
  ok("a click is still given time to merge with the next one", COALESCE_MS >= 500);
  ok("a busy port is looked at again within 2 s (was 8 s)", BUSY_RETRY_MS <= 2_000);
  ok("the busy wait still covers the web's 3-minute follow window", MAX_BUSY_RETRIES * BUSY_RETRY_MS >= 180_000, `${MAX_BUSY_RETRIES * BUSY_RETRY_MS} ms`);
}

// ── 2/3. price list and GST: write what differs ──────────────────────────────
type Call = { table: string; op: string; rows?: any[]; opts?: any };
function fakeDb(stored: Record<string, any[]>, o: { count?: (table: string) => number | null; failSelect?: string } = {}) {
  const calls: Call[] = [];
  const from = (table: string) => {
    let op = "select"; let rows: any[] | undefined; let opts: any; let wantSingle = false;
    const b: any = {
      select(_c?: string, op2?: any) { if (op === "select") opts = op2; return b; },
      eq() { return b; }, order() { return b; }, range() { return b; }, limit() { return b; }, in() { return b; },
      insert(r: any) { op = "insert"; rows = Array.isArray(r) ? r : [r]; return b; },
      upsert(r: any, p: any) { op = "upsert"; rows = Array.isArray(r) ? r : [r]; opts = p; return b; },
      single() { wantSingle = true; return b; },
      then(res: any, rej: any) {
        calls.push({ table, op, rows, opts });
        if (op === "select") {
          if (o.failSelect === table) return Promise.resolve({ data: null, error: { message: "boom" } }).then(res, rej);
          const data = stored[table] ?? [];
          const count = o.count ? o.count(table) : data.length;
          return Promise.resolve({ data, error: null, count }).then(res, rej);
        }
        return Promise.resolve({ data: wantSingle ? { id: 1 } : null, error: null }).then(res, rej);
      },
    };
    return b;
  };
  return { client: { from, rpc: async () => ({ data: 0, error: null }) } as any, calls };
}
const upserts = (calls: Call[], table: string) => calls.filter((c) => c.table === table && c.op === "upsert");
const CO = "TEST CO";
const entry = (item: string, date: string, rate: number) => ({ itemName: item, priceLevel: "DEALER", priceLevelRaw: "Dealer", date, rate, unit: "PC", discountPct: 0 });
const stored = (e: ReturnType<typeof entry>) => ({ company: CO, item_name: e.itemName, price_level: e.priceLevel, price_level_raw: e.priceLevelRaw, effective_from: e.date, rate: e.rate, unit: e.unit, discount_pct: e.discountPct });

async function testPriceList() {
  console.log("\n2. price list writes only what differs");
  const base = [entry("A", "2026-04-01", 100), entry("A", "2026-09-01", 110), entry("B", "2026-04-01", 50)];

  {
    const db = fakeDb({ tally_price_list: base.map(stored) });
    const s = new SupabaseSync() as any; s.client = db.client;
    await quiet(() => s.syncPriceList(base, CO, "test"));
    const up = upserts(db.calls, "tally_price_list");
    ok("unchanged pull: one upsert call", up.length === 1, `${up.length}`);
    ok("unchanged pull: one row (the freshness stamp), not all three", up[0]?.rows?.length === 1, `${up[0]?.rows?.length}`);
    ok("unchanged pull: the newest synced_at still moves", typeof up[0]?.rows?.[0]?.synced_at === "string");
    ok("unchanged pull: the price-list signal is not bumped", upserts(db.calls, "price_list_change_signal").length === 0);
    ok("the stored rows were read once, not twice (the log reuses them)", db.calls.filter((c) => c.table === "tally_price_list" && c.op === "select").length === 1,
      `${db.calls.filter((c) => c.table === "tally_price_list" && c.op === "select").length}`);
  }
  {
    const next = [entry("A", "2026-04-01", 100), entry("A", "2026-09-01", 125), entry("B", "2026-04-01", 50), entry("C", "2026-04-01", 70)];
    const db = fakeDb({ tally_price_list: base.map(stored) });
    const s = new SupabaseSync() as any; s.client = db.client;
    await quiet(() => s.syncPriceList(next, CO, "test"));
    const rows = upserts(db.calls, "tally_price_list").flatMap((c) => c.rows ?? []);
    ok("a moved rate and a new item are written, and only those", rows.length === 2 && rows.map((r) => `${r.item_name}${r.effective_from}`).sort().join() === "A2026-09-01,C2026-04-01",
      JSON.stringify(rows.map((r) => [r.item_name, r.effective_from, r.rate])));
    ok("a real change still bumps the price-list signal", upserts(db.calls, "price_list_change_signal").length === 1);
  }
  {
    const db = fakeDb({ tally_price_list: base.map(stored) }, { count: () => 99 });
    const s = new SupabaseSync() as any; s.client = db.client;
    await quiet(() => s.syncPriceList(base, CO, "test"));
    ok("a stored read the server cut short writes every row (never guesses)", upserts(db.calls, "tally_price_list").flatMap((c) => c.rows ?? []).length === 3);
    ok("...and still announces", upserts(db.calls, "price_list_change_signal").length === 1);
  }
  {
    const db = fakeDb({ tally_price_list: base.map(stored) }, { failSelect: "tally_price_list" });
    const s = new SupabaseSync() as any; s.client = db.client;
    await quiet(() => s.syncPriceList(base, CO, "test"));
    ok("a failed stored read writes every row", upserts(db.calls, "tally_price_list").flatMap((c) => c.rows ?? []).length === 3);
  }
  {
    const e = entry("A", "2026-04-01", 100);
    const held = { ...stored(e), rate: "100.0000" };     // numeric columns can come back as strings
    const db = fakeDb({ tally_price_list: [held] });
    const s = new SupabaseSync() as any; s.client = db.client;
    await quiet(() => s.syncPriceList([e], CO, "test"));
    ok("100 and \"100.0000\" are the same rate (one stamp row, no signal)", upserts(db.calls, "tally_price_list").flatMap((c) => c.rows ?? []).length === 1 && upserts(db.calls, "price_list_change_signal").length === 0);
  }
}

async function testGst() {
  console.log("\n3. GST comparison");
  const rate = { scope: "item" as const, name: "ITEM 1", effectiveFrom: "2025-09-22", gstRate: 5, cgst: 2.5, sgst: 2.5, igst: 5, taxability: "Taxable", parent: "GROUP 1" };
  const mapped = [{ ...gstRateRow(rate, CO), synced_at: new Date().toISOString() }];
  const keyOf = (r: Record<string, unknown>) => `${r.scope}|${r.name}|${r.effective_from}`;
  const heldFull = new Map([[keyOf(mapped[0]), { company: CO, scope: "item", name: "ITEM 1", effective_from: "2025-09-22", gst_rate: "5.000", cgst_rate: "2.500", sgst_rate: "2.500", igst_rate: 5, taxability: "Taxable", parent: "GROUP 1" }]]);
  const { company: _drop, ...noCompany } = heldFull.get(keyOf(mapped[0]))!;
  const heldOld = new Map([[keyOf(mapped[0]), noCompany]]);
  ok("with company on the stored side an unchanged rate is not changed", diffMasterRows(mapped, heldFull, keyOf).changed === 0);
  ok("(the old select, without company, called it changed: this is the bug)", diffMasterRows(mapped, heldOld, keyOf).changed === 1);

  const db = fakeDb({ tally_gst_rates: [heldFull.get(keyOf(mapped[0]))!] });
  const s = new SupabaseSync() as any; s.client = db.client;
  const changed = await quiet(() => s.syncGstRates([rate], CO));
  ok("syncGstRates reports 0 changed for an unchanged rate", changed === 0, `${changed}`);
  const sel = db.calls.find((c) => c.table === "tally_gst_rates" && c.op === "select");
  ok("it reads the stored rows once", !!sel);
  const rows = upserts(db.calls, "tally_gst_rates").flatMap((c) => c.rows ?? []);
  ok("and writes only the freshness row", rows.length === 1);
  ok("withFreshnessStamp: nothing differs gives one row", withFreshnessStamp([1, 2, 3], []).length === 1 && withFreshnessStamp([1, 2, 3], []).join() === "1");
  ok("withFreshnessStamp: something differs keeps just those", withFreshnessStamp([1, 2, 3], [2]).join() === "2");
  ok("withFreshnessStamp: an empty pull stays empty", withFreshnessStamp([], []).length === 0);
}

// ── 4. masters upload beside the voucher read ────────────────────────────────
async function testOverlap() {
  console.log("\n4. masters upload runs beside the voucher read");
  const mk = (voucherThrows: boolean) => {
    const order: string[] = [];
    const orch: any = new SyncOrchestrator("http://127.0.0.1:0", {} as any);
    orch.readMasters = async () => { order.push("masters read"); return { finish: async () => { order.push("masters upload start"); await sleep(60); order.push("masters upload end"); return { success: true, data: { tallymessage: [] }, stats: { stockGroups: 0, units: 0, stockItems: 3, ledgers: 4, godowns: 0, costCentres: 0, elapsedSeconds: 0 } }; } }; };
    orch.syncVouchersOnly = async () => {
      order.push("voucher read start"); await sleep(20);
      if (voucherThrows) throw new Error("voucher read failed");
      order.push("voucher read end");
      return { success: true, data: { tallymessage: [] }, stats: { vouchers: 5, fromDate: "20261128", toDate: "20261128", chunksTotal: 1, chunksSucceeded: 1, chunksFailed: 0, chunkDetails: [], vouchersUploadOk: true, elapsedSeconds: 0 } };
    };
    return { orch, order };
  };
  const plan: any = { company: "X", fromDate: "20261128", toDate: "20261128", mode: "full", chunkStrategy: "daily" };
  {
    const { orch, order } = mk(false);
    const res: any = await quiet(() => orch.syncAll(plan, () => undefined));
    ok("the voucher read starts while the upload is still running", order.indexOf("voucher read start") < order.indexOf("masters upload end"), order.join(" > "));
    ok("syncAll returns only after the upload has finished", order[order.length - 1] === "masters upload end" || order.indexOf("masters upload end") >= 0, order.join(" > "));
    ok("the masters result is in the answer (stock items counted)", res.stats.stockItems === 3 && res.stats.ledgers === 4 && res.stats.vouchers === 5);
  }
  {
    const { orch, order } = mk(true);
    let threw = false;
    await quiet(() => orch.syncAll(plan, () => undefined)).catch(() => { threw = true; });
    ok("a voucher read that throws still waits for the upload, then throws", threw && order.includes("masters upload end"), order.join(" > "));
  }
  {
    const { orch, order } = mk(false);
    await quiet(() => orch.syncAll({ ...plan, mode: "masters-only" }, () => undefined));
    ok("masters-only: no voucher read, upload awaited", !order.includes("voucher read start") && order.includes("masters upload end"));
  }
}

// ── 5. the queue wake ────────────────────────────────────────────────────────
async function testWake() {
  console.log("\n5. the new-job wake");
  ok("a signal for erp_jobs is a job signal", isJobSignal({ new: { table_name: JOB_SIGNAL_TABLE } }));
  ok("another table's signal is not", !isJobSignal({ new: { table_name: "erp_control" } }));
  ok("junk payloads are not", !isJobSignal(null) && !isJobSignal({}) && !isJobSignal({ new: null }) && !isJobSignal("x"));

  // A queue loop with a fake clock and fake timers: no real waiting.
  const mkLoop = (runOnce: () => Promise<any>) => {
    let t = 1_000_000;
    const timers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
    let rounds = 0;
    const loop = new PrimaryQueueLoop({
      agent: { runOnce: async () => { rounds++; return runOnce(); } } as any,
      pollMs: 30_000, busyMs: 2_000, log: () => undefined, now: () => t, rand: () => 0.5,
      setTimer: (fn, ms) => { const h = { fn, ms, live: true }; timers.push(h); return h; },
      clearTimer: (h) => { (h as any).live = false; },
    });
    return { loop, timers, advance: (ms: number) => { t += ms; }, rounds: () => rounds };
  };
  const idle = async () => ({ held: true, results: [], settled: [], stopped: null });

  {
    const k = mkLoop(idle);
    k.loop.start(); await sleep(5);
    ok("start: one round at once, then a 30 s wait", k.rounds() === 1 && k.timers.at(-1)!.ms === 30_000, `${k.rounds()} rounds, wait ${k.timers.at(-1)?.ms}`);
    const pending = k.timers.at(-1)!;
    k.advance(5_000);
    const woke = k.loop.wake(); await sleep(5);
    ok("wake: a round starts at once", woke === true && k.rounds() === 2);
    ok("wake: the waiting 30 s timer is cancelled", pending.live === false);
    ok("wake: the loop goes back to the 30 s poll after an idle round", k.timers.at(-1)!.ms === 30_000);
    const again = k.loop.wake(); await sleep(5);
    ok(`wakes closer than ${WAKE_MIN_GAP_MS} ms count once`, again === false && k.rounds() === 2);
    k.advance(WAKE_MIN_GAP_MS + 1);
    k.loop.stop();
    ok("a stopped loop is not woken", k.loop.wake() === false);
  }
  {
    // A wake that arrives while a round is running: no second round beside it, and the next look comes soon.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    let first = true;
    const k = mkLoop(async () => { if (first) { first = false; await gate; } return { held: true, results: [], settled: [], stopped: null }; });
    k.loop.start(); await sleep(5);
    const during = k.loop.wake();
    ok("wake during a round does not start a second one", during === false && k.rounds() === 1);
    release(); await sleep(10);
    ok(`the round after it is ${WAKE_RECHECK_MS} ms away, not 30 s`, k.timers.at(-1)!.ms === WAKE_RECHECK_MS, `${k.timers.at(-1)?.ms}`);
    k.loop.stop();
  }
  {
    // A failing round: the back-off is never shortened by a wake.
    let calls = 0;
    const k = mkLoop(async () => { calls++; throw new Error("database timed out"); });
    k.loop.start(); await sleep(5);
    ok("a failed round waits 30 s before the next (first failure)", k.timers.at(-1)!.ms === 30_000);
    k.advance(WAKE_MIN_GAP_MS + 1);
    k.loop.wake(); await sleep(5);
    ok("a wake still runs a round, and the second failure backs off to 60 s", calls === 2 && k.timers.at(-1)!.ms === 60_000, `${calls} calls, wait ${k.timers.at(-1)?.ms}`);
    k.loop.stop();
  }

  // The listener, with a fake client.
  {
    const handlers: Array<(p: unknown) => void> = [];
    const statusCbs: Array<(s: string, e?: Error) => void> = [];
    let removed = 0; let channels = 0;
    const client: any = {
      channel: () => { channels++; const ch: any = { on: (_t: string, _f: any, cb: (p: unknown) => void) => { handlers.push(cb); return ch; }, subscribe: (cb: any) => { statusCbs.push(cb); return ch; } }; return ch; },
      removeChannel: async () => { removed++; },
    };
    let wakes = 0;
    const h = startQueueWake({ wake: () => { wakes++; }, log: () => undefined, client });
    ok("it subscribes", !!h && channels === 1);
    statusCbs[0]("SUBSCRIBED");
    ok("on connecting it looks once (a job made while the socket was down)", wakes === 1);
    handlers[0]({ new: { table_name: "erp_jobs" } });
    ok("a job signal wakes the loop", wakes === 2);
    handlers[0]({ new: { table_name: "erp_proposals" } });
    ok("another table's signal does not", wakes === 2);
    handlers[0]({ new: { table_name: "erp_jobs" } });
    ok("every job signal wakes it (the loop itself merges bursts)", wakes === 3);
    h!.stop();
    ok("stop removes the channel", removed >= 1);
  }
  {
    ok("no client (offline or sandbox): no listener, nothing thrown", startQueueWake({ wake: () => undefined, log: () => undefined, client: null }) === null);
  }
}

async function testMapLimit() {
  console.log("\n6. mapLimit");
  let running = 0, peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => { running++; peak = Math.max(peak, running); await sleep(10 - n); running--; return n * 2; });
  ok("keeps the input order", out.join() === "2,4,6,8,10,12,14");
  ok("never more than the limit at once", peak <= 3 && peak >= 2, `peak ${peak}`);
  let rejected = false;
  await mapLimit([1, 2, 3], 2, async (n) => { if (n === 2) throw new Error("x"); return n; }).catch(() => { rejected = true; });
  ok("a rejection rejects the whole call", rejected);
  ok("empty input is fine", (await mapLimit([], 4, async (n: number) => n)).length === 0);
}

(async () => {
  testWaits();
  await testPriceList();
  await testGst();
  await testOverlap();
  await testWake();
  await testMapLimit();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("TEST CRASHED:", e); process.exit(1); });
