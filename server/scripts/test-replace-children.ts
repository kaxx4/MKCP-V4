/**
 * #112: voucher child rows (ledger + inventory entries) are replaced per
 * voucher chunk through ONE RPC call, so a failure cannot leave a voucher with
 * its children deleted and not yet re-inserted.
 *
 * Fixture-only: the RPC is a fake that behaves like the SQL function would:
 * it either applies a whole chunk or, when told to fail, changes nothing.
 * No network, no Supabase.
 *
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

function makeSync(store: Store, failOnCall: number | null) {
  const calls: Array<{ guids: string[] }> = [];
  const sync = new SupabaseSync() as any;
  sync.client = {
    rpc: async (name: string, args: any) => {
      assert.equal(name, "replace_voucher_children");
      calls.push({ guids: args.p_guids });
      if (failOnCall === calls.length) {
        return { data: null, error: { message: "boom: insert failed" } }; // nothing applied
      }
      const set = new Set<string>(args.p_guids);
      store.ledger = store.ledger.filter((r) => !set.has(r.voucher_guid)).concat(args.p_ledger);
      store.inventory = store.inventory.filter((r) => !set.has(r.voucher_guid)).concat(args.p_inventory);
      return { data: { ledger: args.p_ledger.length, inventory: args.p_inventory.length }, error: null };
    },
  };
  return { sync, calls };
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
    const { sync, calls } = makeSync(store, null);
    const { ledgerRows, inventoryRows } = freshRows(guids);
    await sync.replaceVoucherChildren(COMPANY, guids, ledgerRows, inventoryRows);
    assert.deepEqual(calls.map((c) => c.guids.length), [100, 100, 50]);
    assert.ok(store.ledger.every((r) => r.ledger_name === "NEW"));
    assert.equal(store.ledger.length, 250);
  });

  await run("a failing chunk leaves the previous rows of that chunk and later chunks untouched", async () => {
    const guids = guidsOf(250);
    const store = seed(guids);
    const { sync } = makeSync(store, 2);
    const { ledgerRows, inventoryRows } = freshRows(guids);
    await assert.rejects(() => sync.replaceVoucherChildren(COMPANY, guids, ledgerRows, inventoryRows));
    const byChunk = (lo: number, hi: number) =>
      store.ledger.filter((r) => guids.slice(lo, hi).includes(r.voucher_guid));
    // chunk 1 (0-99) applied; chunk 2 (100-199) and chunk 3 (200-249) keep their OLD rows
    assert.ok(byChunk(0, 100).every((r) => r.ledger_name === "NEW"));
    assert.ok(byChunk(100, 200).every((r) => r.ledger_name.startsWith("OLD")));
    assert.equal(byChunk(100, 200).length, 200);
    assert.ok(byChunk(200, 250).every((r) => r.ledger_name.startsWith("OLD")));
    assert.equal(byChunk(200, 250).length, 100);
  });

  await run("a voucher with no new entries still has its old children deleted", async () => {
    const guids = ["gA", "gB"];
    const store = seed(guids);
    const { sync, calls } = makeSync(store, null);
    const ledgerRows = [{ voucher_guid: "gA", company: COMPANY, ledger_name: "NEW", amount: 5 }];
    await sync.replaceVoucherChildren(COMPANY, guids, ledgerRows, []);
    assert.deepEqual(calls[0].guids, ["gA", "gB"]);
    assert.equal(store.ledger.filter((r) => r.voucher_guid === "gB").length, 0);
    assert.equal(store.inventory.filter((r) => r.voucher_guid === "gB").length, 0);
  });

  if (failed > 0) {
    console.error(`${failed} replace-children case(s) failed`);
    process.exit(1);
  }
  console.log("replace-children: all cases pass");
}

main();
