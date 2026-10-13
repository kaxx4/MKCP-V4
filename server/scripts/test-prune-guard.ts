/**
 * #117: the per-day prune caller must treat the guard's -1 as "refused" and
 * must pass the explicit override flag through, default OFF.
 *
 * Fixture-only: the Supabase RPC is a scripted fake assigned onto the private
 * client field. No network. Nothing here touches the live database.
 *
 * Run: npx tsx scripts/test-prune-guard.ts
 */
import assert from "node:assert/strict";
import { SupabaseSync } from "../src/services/supabaseSync.js";

type Rpc = { name: string; args: Record<string, unknown> };

function makeSync(reply: number) {
  const calls: Rpc[] = [];
  const sync = new SupabaseSync() as any;
  sync.client = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return { data: reply, error: null };
    },
  };
  return { sync, calls };
}

const DAYS = ["20261001"];
const GUIDS = ["g1", "g2"];

async function main() {
  const saved = process.env.MKCP_ALLOW_BIG_PRUNE;
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

  await run("guard refusal (-1) is reported as guardTripped and deletes nothing", async () => {
    delete process.env.MKCP_ALLOW_BIG_PRUNE;
    const { sync } = makeSync(-1);
    const r = await sync.deleteVoucherOrphansForDays("CO", DAYS, GUIDS);
    assert.deepEqual(r, { deleted: 0, guardTripped: true });
  });

  await run("default call passes p_force=false (override OFF)", async () => {
    delete process.env.MKCP_ALLOW_BIG_PRUNE;
    const { sync, calls } = makeSync(0);
    await sync.deleteVoucherOrphansForDays("CO", DAYS, GUIDS);
    assert.equal(calls[0].name, "delete_voucher_orphans_for_days");
    assert.equal(calls[0].args.p_force, false);
    assert.deepEqual(calls[0].args.p_days, ["2026-10-01"]);
  });

  await run("MKCP_ALLOW_BIG_PRUNE=1 passes p_force=true", async () => {
    process.env.MKCP_ALLOW_BIG_PRUNE = "1";
    const { sync, calls } = makeSync(0);
    await sync.deleteVoucherOrphansForDays("CO", DAYS, GUIDS);
    assert.equal(calls[0].args.p_force, true);
    delete process.env.MKCP_ALLOW_BIG_PRUNE;
  });

  await run("a normal prune reports the deleted count and no guard trip", async () => {
    delete process.env.MKCP_ALLOW_BIG_PRUNE;
    const { sync } = makeSync(3);
    const r = await sync.deleteVoucherOrphansForDays("CO", DAYS, GUIDS);
    assert.deepEqual(r, { deleted: 3, guardTripped: false });
  });

  if (saved === undefined) delete process.env.MKCP_ALLOW_BIG_PRUNE;
  else process.env.MKCP_ALLOW_BIG_PRUNE = saved;

  if (failed > 0) {
    console.error(`${failed} prune-guard case(s) failed`);
    process.exit(1);
  }
  console.log("prune-guard: all cases pass");
}

main();
