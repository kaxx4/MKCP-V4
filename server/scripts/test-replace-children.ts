/**
 * #112 CALLER-ONLY TEST. It fakes the RPC and the table client, so it proves what
 * the TypeScript does (chunking, one RPC per chunk, failure isolation, the 045-missing
 * fallback, un-stamping headers). It does NOT prove the SQL. The SQL is proven only by
 * migrations/selftests/045_replace_children_selftest.sql, run by the owner on a COPY
 * before 045 is applied.
 *
 * Fixture-only. No network, no Supabase.
 * Run: npx tsx scripts/test-replace-children.ts
 */
import assert from "node:assert/strict";
import { SupabaseSync } from "../src/services/supabaseSync.js";

const COMPANY = "FIXTURE CO";

type Store = { ledger: any[]; inventory: any[] };

function seed(guids: string[]): Store {
  const ledger: any[] = [];
  const inventory: any[] = [];
  for (const g of guids) {
    ledger.push({ voucher_guid: g, company: COMPANY, ledger_name: "OLD", amount: 1 });
    ledger.push({ voucher_guid: g, company: COMPANY, ledger_name: "OLD2", amount: 2 });
    inventory.push({ voucher_guid: g, company: COMPANY, stock_item_name: "OLD", amount: 3 });
  }
  return { ledger, inventory };
}

type RpcReply = { data: any; error: any };

/**
 * Fake client. `rpcFor(callNo)` decides each RPC reply; the RPC applies a chunk only
 * when it returns no error (the SQL function is atomic, so an error changes nothing).
 * Table calls (legacy path, header un-stamp) are recorded and applied to the store.
 */
function makeSync(store: Store, rpcFor: (callNo: number) => RpcReply) {
  const rpcCalls: Array<{ guids: string[] }> = [];
  const tableCalls: Array<{ table: string; op: string; guids?: string[]; patch?: any }> = [];
  const sync = new SupabaseSync() as any;
  sync.client = {
    rpc: async (name: string, args: any) => {
      assert.equal(name, "replace_voucher_children");
      rpcCalls.push({ guids: args.p_guids });
      const reply = rpcFor(rpcCalls.length);
      if (!reply.error) {
        const set = new Set<string>(args.p_guids);
        store.ledger = store.ledger.filter((r) => !set.has(r.voucher_guid)).concat(args.p_ledger);
        store.inventory = store.inventory.filter((r) => !set.has(r.voucher_guid)).concat(args.p_inventory);
        return { data: { ledger: args.p_ledger.length, inventory: args.p_inventory.length }, error: null };
      }
      return reply;
    },
    from: (table: string) => {
      const f: any = { filters: {} as Record<string, any>, guids: undefined as string[] | undefined, op: "select", patch: undefined as any, rows: undefined as any[] | undefined };
      f.delete = () => { f.op = "delete"; return f; };
      f.update = (p: any) => { f.op = "update"; f.patch = p; return f; };
      f.insert = (rows: any[]) => { f.op = "insert"; f.rows = rows; return f; };
      f.eq = (c: string, v: any) => { f.filters[c] = v; return f; };
      f.in = (c: string, v: any[]) => { f.guids = v; f.inCol = c; return f; };
      f.then = (res: any, rej: any) => {
        const out = (() => {
          tableCalls.push({ table, op: f.op, guids: f.guids, patch: f.patch });
          if (table === "tally_vouchers" && f.op === "update") return { error: null };
          if (f.op === "delete") {
            const set = new Set<string>(f.guids ?? []);
            if (table === "tally_voucher_ledger_entries") store.ledger = store.ledger.filter((r) => !set.has(r.voucher_guid));
            if (table === "tally_voucher_inventory_entries") store.inventory = store.inventory.filter((r) => !set.has(r.voucher_guid));
          }
          if (f.op === "insert") {
            if (table === "tally_voucher_ledger_entries") store.ledger.push(...f.rows);
            if (table === "tally_voucher_inventory_entries") store.inventory.push(...f.rows);
          }
          return { error: null };
        })();
        return Promise.resolve(out).then(res, rej);
      };
      return f;
    },
  };
  return { sync, rpcCalls, tableCalls };
}

function freshRows(guids: string[]) {
  const ledgerRows: any[] = [];
  const inventoryRows: any[] = [];
  for (const g of guids) {
    ledgerRows.push({ voucher_guid: g, company: COMPANY, ledger_name: "NEW", amount: 10 });
    inventoryRows.push({ voucher_guid: g, company: COMPANY, stock_item_name: "NEW", amount: 30 });
  }
  return { ledgerRows, inventoryRows };
}

const guidsOf = (n: number) => Array.from({ length: n }, (_, i) => `g${String(i).padStart(3, "0")}`);
const ok: RpcReply = { data: null, error: null };
const boom: RpcReply = { data: null, error: { message: "boom: insert failed" } };
const missing: RpcReply = { data: null, error: { code: "PGRST202", message: "Could not find the function public.replace_voucher_children" } };

async function main() {
  let failed = 0;
  const run = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
      console.log(`PASS ${name}`);
    } catch (e: any) {
      failed++;
      console.log(`FAIL ${name}\n     ${e?.message ?? e}`);
    }
  };

  await run("250 vouchers are replaced in 3 chunks (100, 100, 50), one RPC each", async () => {
    const guids = guidsOf(250);
    const store = seed(guids);
    const { sync, rpcCalls } = makeSync(store, () => ok);
    const { ledgerRows, inventoryRows } = freshRows(guids);
    const r = await sync.replaceVoucherChildren(COMPANY, guids, ledgerRows, inventoryRows);
    assert.deepEqual(rpcCalls.map((c) => c.guids.length), [100, 100, 50]);
    assert.deepEqual(r.failedGuids, []);
    assert.ok(store.ledger.every((r: any) => r.ledger_name === "NEW"));
    assert.equal(store.ledger.length, 250);
  });

  await run("a failing chunk is reported in failedGuids and later chunks still apply", async () => {
    const guids = guidsOf(250);
    const store = seed(guids);
    const { sync } = makeSync(store, (n) => (n === 2 ? boom : ok));
    const { ledgerRows, inventoryRows } = freshRows(guids);
    const r = await sync.replaceVoucherChildren(COMPANY, guids, ledgerRows, inventoryRows);
    assert.equal(r.failedGuids.length, 100);
    assert.deepEqual(r.failedGuids, guids.slice(100, 200));
    const byChunk = (lo: number, hi: number) => store.ledger.filter((x: any) => guids.slice(lo, hi).includes(x.voucher_guid));
    assert.ok(byChunk(0, 100).every((x: any) => x.ledger_name === "NEW"));
    // chunk 2 keeps its OLD rows (atomic RPC changed nothing); chunk 3 is NOT aborted
    assert.ok(byChunk(100, 200).every((x: any) => x.ledger_name.startsWith("OLD")));
    assert.ok(byChunk(200, 250).every((x: any) => x.ledger_name === "NEW"));
  });

  await run("a failed chunk un-stamps its voucher headers (alter_id null) so they re-pull", async () => {
    const guids = guidsOf(150);
    const store = seed(guids);
    const { sync, tableCalls } = makeSync(store, (n) => (n === 2 ? boom : ok));
    const { ledgerRows, inventoryRows } = freshRows(guids);
    const r = await sync.replaceVoucherChildren(COMPANY, guids, ledgerRows, inventoryRows);
    await sync.clearHeaderAlterIds(COMPANY, r.failedGuids);
    const unstamp = tableCalls.filter((c) => c.table === "tally_vouchers" && c.op === "update");
    assert.equal(unstamp.length, 1);
    assert.deepEqual(unstamp[0].patch, { alter_id: null });
    assert.deepEqual(unstamp[0].guids, guids.slice(100, 150));
  });

  await run("045 not installed (PGRST202): legacy delete + insert keeps the voucher's children", async () => {
    const guids = ["gA", "gB"];
    const store = seed(guids);
    const { sync, tableCalls } = makeSync(store, () => missing);
    const { ledgerRows, inventoryRows } = freshRows(guids);
    const r = await sync.replaceVoucherChildren(COMPANY, guids, ledgerRows, inventoryRows);
    assert.deepEqual(r.failedGuids, []);
    assert.ok(tableCalls.some((c) => c.table === "tally_voucher_ledger_entries" && c.op === "delete"));
    assert.equal(store.ledger.filter((x: any) => x.ledger_name === "NEW").length, 2);
    assert.equal(store.ledger.filter((x: any) => x.ledger_name.startsWith("OLD")).length, 0);
  });

  await run("a voucher with no new entries still has its old children deleted", async () => {
    const guids = ["gA", "gB"];
    const store = seed(guids);
    const { sync, rpcCalls } = makeSync(store, () => ok);
    const ledgerRows = [{ voucher_guid: "gA", company: COMPANY, ledger_name: "NEW", amount: 5 }];
    await sync.replaceVoucherChildren(COMPANY, guids, ledgerRows, []);
    assert.deepEqual(rpcCalls[0].guids, ["gA", "gB"]);
    assert.equal(store.ledger.filter((r: any) => r.voucher_guid === "gB").length, 0);
    assert.equal(store.inventory.filter((r: any) => r.voucher_guid === "gB").length, 0);
  });

  if (failed > 0) {
    console.error(`${failed} replace-children case(s) failed`);
    process.exit(1);
  }
  console.log("replace-children (caller-only): all cases pass");
}

main();
