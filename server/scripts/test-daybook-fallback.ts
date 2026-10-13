/**
 * #111: the Day Book fallback must never make a day "authoritative".
 *
 * Fixture-only: the Tally post is replaced by a scripted fake through the
 * `post` seam on SyncOrchestrator. No network, no Supabase.
 *
 * Run: npx tsx scripts/test-daybook-fallback.ts
 */
import assert from "node:assert/strict";
import { SyncOrchestrator } from "../src/services/syncOrchestrator.js";

type Step = { reply: any } | { throws: string };

function voucherMessage(guid: string, date: string) {
  return { VOUCHER: { GUID: guid, DATE: date, VOUCHERTYPENAME: "Sales" } };
}

function response(vouchers: Array<[string, string]>) {
  return {
    ENVELOPE: {
      BODY: {
        DATA: {
          TALLYMESSAGE: vouchers.map(([g, d]) => voucherMessage(g, d)),
        },
      },
    },
  };
}

function makeOrchestrator(steps: Step[]) {
  const calls: string[] = [];
  const orch = new SyncOrchestrator("http://127.0.0.1:0", {} as any) as any;
  orch.post = async (_url: string, xml: string) => {
    calls.push(xml);
    const step = steps.shift();
    if (!step) throw new Error("fake post: no scripted step left");
    if ("throws" in step) throw new Error(step.throws);
    return step.reply;
  };
  return { orch, calls };
}

const DAY = "20261001";
const guidsOf = (r: any) => r.converted.tallymessage.map((v: any) => v.guid ?? v.GUID);

const cases: Array<[string, () => Promise<void>]> = [
  ["(a) Collection answers: source=collection, day rows kept", async () => {
    const { orch } = makeOrchestrator([{ reply: response([["g1", DAY]]) }]);
    const r = await orch._fetchVoucherChunk("CO", DAY, DAY, "d", 1000);
    assert.equal(r.source, "collection");
    assert.deepEqual(guidsOf(r), ["g1"]);
  }],
  ["(b) Collection empty, Day Book returns another day too: only in-window rows, source=daybook", async () => {
    const { orch } = makeOrchestrator([
      { reply: response([]) },
      { reply: response([["g2", "20260915"], ["g3", DAY]]) },
    ]);
    const r = await orch._fetchVoucherChunk("CO", DAY, DAY, "d", 1000);
    assert.equal(r.source, "daybook");
    assert.deepEqual(guidsOf(r), ["g3"]);
  }],
  ["(c) Collection throws, Day Book answers: kept, source=daybook", async () => {
    const { orch } = makeOrchestrator([
      { throws: "socket hang up" },
      { reply: response([["g3", DAY]]) },
    ]);
    const r = await orch._fetchVoucherChunk("CO", DAY, DAY, "d", 1000);
    assert.equal(r.source, "daybook");
    assert.deepEqual(guidsOf(r), ["g3"]);
  }],
  ["(d) Abort propagates from the Collection call", async () => {
    const { orch } = makeOrchestrator([{ throws: "Aborted by caller" }]);
    await assert.rejects(() => orch._fetchVoucherChunk("CO", DAY, DAY, "d", 1000));
  }],
];

async function main() {
let failed = 0;
  for (const [name, fn] of cases) {
    try {
      await fn();
      console.log(`PASS ${name}`);
    } catch (e: any) {
      failed++;
      console.log(`FAIL ${name}\n     ${e?.message ?? e}`);
    }
  }
  if (failed > 0) {
    console.error(`${failed} daybook-fallback case(s) failed`);
    process.exit(1);
  }
  console.log("daybook-fallback: all cases pass");
}

main();
