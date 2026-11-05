/**
 * Rig R3: crowd simulator (task 1-0), on the LIVE ERP test queue.
 *
 * 10 simulated people queue 60 ZZ TEST pushes within the run (target: 60 in 5
 * minutes), while 100 connections read the queue at once and 3 agents drain it
 * against the simulated Tally (nothing reaches Tally). Pass: every job is
 * claimed once and booked once, none is lost, and every row is deleted at the end.
 * Realtime connections are not part of this run: the ERP's change signals are
 * built in task 1-6, which re-runs R3 with them.
 *
 * Writes only `erp_push_queue_test` rows (live-test rules 1 to 3), and deletes them.
 *   $env:MKCP_ERP_TEST_QUEUE='on'; npx tsx scripts/rigs/r3-crowd.ts --out <file.json>
 */
import "dotenv/config";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { erpTestQueueClient, ERP_TEST_TABLE } from "../../src/services/supabaseClient.js";
import { practiceCompany } from "../../src/services/tallyRole.js";
import { runErpTestQueueOnce, supabaseTestQueue } from "../../src/services/erpTestQueueAgent.js";
import { SimTally, rigPayload, indiaToday } from "./lib/simTally.js";

const OUT = (() => { const i = process.argv.indexOf("--out"); return i >= 0 ? process.argv[i + 1] : null; })();
const ms = (t: number) => Math.round(performance.now() - t);

(async () => {
  const c = erpTestQueueClient();
  const company = practiceCompany()!;
  const sim = new SimTally();
  const stamp = "R3" + Date.now().toString().slice(-5);
  const prefix = `ZZTEST-${stamp}-`;
  const t0 = performance.now();
  const enqueueMs: number[] = [];
  let enqueueErrors = 0;

  // 10 people, 6 pushes each, spread over about 30 s.
  const people = Array.from({ length: 10 }, (_, p) => (async () => {
    for (let k = 0; k < 6; k++) {
      await new Promise((r) => setTimeout(r, Math.random() * 5000));
      const n = p * 6 + k, t = performance.now();
      const { error } = await c.rpc("enqueue_erp_test_job", { p_key: `${prefix}${n}`, p_label: "ZZ TEST R3 crowd", p_company: company, p_payload: rigPayload(stamp, n, indiaToday()) });
      enqueueMs.push(ms(t));
      if (error) enqueueErrors++;
    }
  })());

  // 100 connections reading at once, three times.
  const readMs: number[] = []; let readErrors = 0;
  const readers = (async () => {
    for (let wave = 0; wave < 3; wave++) {
      await new Promise((r) => setTimeout(r, 4000));
      await Promise.all(Array.from({ length: 100 }, async () => {
        const t = performance.now();
        const { error } = await c.from(ERP_TEST_TABLE).select("id,state").like("idempotency_key", `${prefix}%`);
        readMs.push(ms(t)); if (error) readErrors++;
      }));
    }
  })();

  // 3 agents drain until all 60 are final.
  const claims: string[] = [];
  let done = false;
  const agents = [0, 1, 2].map(async (a) => {
    while (!done && performance.now() - t0 < 300_000) {
      const r = await runErpTestQueueOnce(supabaseTestQueue(c), { tallyUrl: "http://127.0.0.1:1", agent: `r3-agent-${a}`, limit: 2, push: sim.push }).catch(() => null);
      for (const x of r?.results ?? []) claims.push(x.key);
      if (!r?.claimed) await new Promise((res) => setTimeout(res, 300));
    }
  });
  await Promise.all(people);
  await readers;
  while (performance.now() - t0 < 300_000) {
    const { data } = await c.from(ERP_TEST_TABLE).select("state").like("idempotency_key", `${prefix}%`);
    if ((data ?? []).length === 60 && (data ?? []).every((d: any) => d.state === "succeeded")) break;
    await new Promise((res) => setTimeout(res, 500));
  }
  done = true;
  await Promise.all(agents);

  const { data: rows } = await c.from(ERP_TEST_TABLE).select("idempotency_key,state,attempts").like("idempotency_key", `${prefix}%`);
  const states = (rows ?? []).reduce<Record<string, number>>((m: any, r: any) => ({ ...m, [r.state]: (m[r.state] ?? 0) + 1 }), {});
  const claimedTwice = claims.length - new Set(claims).size;
  const del = await c.from(ERP_TEST_TABLE).delete().like("idempotency_key", `${prefix}%`).eq("is_test", true);
  const { data: left } = await c.from(ERP_TEST_TABLE).select("id").like("idempotency_key", `${prefix}%`);
  const p95 = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length * 0.95)] ?? null;
  const report = {
    rig: "R3 crowd simulator", ranAt: new Date().toISOString(), people: 10, pushes: 60, readConnections: "100 at once, 3 waves",
    totalMs: ms(t0), enqueue: { n: enqueueMs.length, errors: enqueueErrors, p95ms: p95(enqueueMs) },
    reads: { n: readMs.length, errors: readErrors, p95ms: p95(readMs) },
    states, booked: sim.books.size, bookedTwice: sim.doubled().length, claimedTwice,
    maxAttempts: Math.max(0, ...(rows ?? []).map((r: any) => r.attempts)),
    cleanup: { deleteError: del.error?.message ?? null, rowsLeft: (left ?? []).length },
    pass: states.succeeded === 60 && sim.books.size === 60 && sim.doubled().length === 0 && claimedTwice === 0 && (left ?? []).length === 0,
  };
  console.log(JSON.stringify(report, null, 2));
  if (OUT) { mkdirSync(dirname(OUT), { recursive: true }); writeFileSync(OUT, JSON.stringify(report, null, 2)); }
  process.exit(report.pass ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
