/**
 * Task 1-6 on the live project, under the live-test rules: how fast does a change signal reach another open
 * connection, and does a dropped connection recover with no missed change? No Tally is touched.
 *
 * It writes only ZZTEST rows in the new ERP table `erp_change_signals` (through `erp_signal_test_emit`, which
 * the database lets only the registered sandbox laptop call) and deletes them at the end
 * (`erp_signal_test_cleanup`). It never writes a table main reads.
 *
 *   1. LATENCY (R3): one subscriber on the live realtime channel, 100 trials. Each trial emits one signal
 *      through the database function and waits for it to arrive on the channel. The clock starts BEFORE the
 *      function call, so the figure includes the call's own round trip (the pessimistic reading). Pass mark:
 *      95 of 100 inside 2 seconds, and none lost.
 *   2. FLAPS (R7, B2): the realtime socket is closed, 5 signals are emitted while it is down, the socket is
 *      opened again, and the catch-up function (the one a screen calls) must name the run's table for those
 *      5 signals, and the channel must carry new signals again.
 *
 * THE REALTIME SOCKET IS OUTSIDE THE FENCE. `erpTestFence` judges HTTP requests (rest and rpc); a realtime websocket is not one, so
 * the fence never sees what this rig subscribes to. The protection here is the rig itself: it listens to one table
 * (`erp_change_signals`) and filters on its own run name, it writes only through `erp_signal_test_emit`, and it is a rig
 * (never imported by the agent). Do not copy this client into agent code (task 1-6, review of thread 8, item 16).
 *
 * Not run here, and why: the "wrong-role subscriber" check (R6) needs a signed-in session without an ERP role,
 * and live-test rule 4 forbids a fake user on live sign-in. The database-level half is in
 * supabase/live-tests/1-6_signals.sql (a signed-in person with no ERP role and the public key read no signal).
 *
 *   $env:MKCP_ERP_TEST_QUEUE='on'; npx tsx scripts/rigs/realtime-signals-live.ts --out <file.json>
 */
import "dotenv/config";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { guardScriptWrites } from "../../src/services/scriptWriteGuard.js";
guardScriptWrites("rigs/realtime-signals-live");
import { erpTestQueueClient, agentMachineId, agentMachineKey } from "../../src/services/supabaseClient.js";
import { leftoverCheck, recordError, rigExitCode, rigSummary } from "./rigExit.js";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };
const OUT = arg("--out");
const TRIALS = Number(arg("--trials") ?? 100);
/** latency 2, flap 2, cleanup 2. The rig exits 0 only when exactly this many checks ran and passed (review of thread 8, item 12). */
const EXPECTED_CHECKS = 6;
const c = erpTestQueueClient();
const machine = agentMachineId(), key = agentMachineKey();
const run = `ZZTESTrt${Date.now().toString(36)}`.slice(0, 40);
const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail: string) => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name} (${detail})`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]; };

function provenance() {
  const git = (...a: string[]) => (spawnSync("git", a, { encoding: "utf8", cwd: dirname(process.argv[1]) }).stdout ?? "").trim();
  return { commit: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}"), dirtyFiles: git("status", "--porcelain", "--", "..", "../../src").split("\n").filter(Boolean) };
}

const waiting = new Map<string, (at: number) => void>();
let arrived = 0;
const channel = c.channel(`zz-rig-${run}`).on(
  "postgres_changes" as never,
  { event: "INSERT", schema: "public", table: "erp_change_signals" } as never,
  ((p: { new?: { table_name?: string; row_key?: string } }) => {
    if (p.new?.table_name !== run) return;
    arrived += 1;
    waiting.get(p.new.row_key ?? "")?.(Date.now());
  }) as never,
);

async function subscribe(): Promise<void> {
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error("the channel did not subscribe within 20 s")), 20_000);
    channel.subscribe((status: string) => { if (status === "SUBSCRIBED") { clearTimeout(t); res(); } if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") { clearTimeout(t); rej(new Error(status)); } });
  });
}
const emit = async (n: string) => {
  const { error } = await c.rpc("erp_signal_test_emit", { p_machine: machine, p_key: key, p_run: run, p_key_n: n });
  if (error) throw new Error(`emit ${n}: ${error.message}`);
};

async function main(): Promise<void> {
try {
  await subscribe();
  await sleep(1500);   // let the server finish wiring the subscription before the first trial

  // 1. latency
  const lat: number[] = []; let lost = 0;
  for (let i = 1; i <= TRIALS; i++) {
    const k = `t${i}`;
    const got = new Promise<number>((res) => { const to = setTimeout(() => res(-1), 10_000); waiting.set(k, (at) => { clearTimeout(to); res(at); }); });
    const t0 = Date.now();
    await emit(k);
    const at = await got; waiting.delete(k);
    if (at < 0) lost += 1; else lat.push(at - t0);
    await sleep(60);
  }
  const within = lat.filter((x) => x <= 2000).length;
  check(`latency: ${TRIALS} trials, none lost`, lost === 0, `${lat.length} arrived, ${lost} lost`);
  check(`latency: at least 95 percent inside 2 seconds`, within >= Math.ceil(TRIALS * 0.95), `${within} of ${TRIALS} inside 2000 ms; median ${pct(lat, 0.5)} ms, p95 ${pct(lat, 0.95)} ms, max ${Math.max(...lat)} ms, min ${Math.min(...lat)} ms`);

  // 2. a flap
  const before = arrived;
  await c.realtime.disconnect();
  await sleep(1500);
  for (let i = 1; i <= 5; i++) await emit(`flap${i}`);
  const { data: during } = await c.rpc("erp_signal_catch_up", { p_cursor: 0 });
  const downTables = ((during as { tables?: { table: string; count: number }[] })?.tables ?? []).filter((t) => t.table === run);
  check("flap: while the socket is down the catch-up function still names the run's table (nothing is only on the socket)", downTables.length === 1 && downTables[0].count >= 5, `${JSON.stringify(downTables)}`);
  c.realtime.connect();
  await sleep(500);
  const got6 = new Promise<boolean>((res) => { const to = setTimeout(() => res(false), 20_000); waiting.set("after", () => { clearTimeout(to); res(true); }); });
  await sleep(3000);   // the client re-joins its channel by itself
  await emit("after");
  check("flap: after the socket returns the channel carries new signals again with no resubscribe by hand", await got6, `arrived while down: ${arrived - before - (await got6 ? 1 : 0)}`);
} catch (e) {
  recordError(results, e);
  console.log("FAIL the run finished without an error (" + (e as Error).message + ")");
} finally {
  const { data: n, error } = await c.rpc("erp_signal_test_cleanup", { p_machine: machine, p_key: key, p_run: run });
  check("cleanup: this run's test signals are removed", !error && Number(n) >= TRIALS, `removed ${n}${error ? ` error ${error.message}` : ""}`);
  const leftRead = await c.from("erp_change_signals").select("id", { count: "exact", head: true }).eq("is_test", true).eq("table_name", run);
  const leftChk = leftoverCheck("cleanup: none of them is left", { count: leftRead.count, error: leftRead.error });
  results.push(leftChk); console.log(`${leftChk.ok ? "PASS" : "FAIL"} ${leftChk.name} (${leftChk.detail})`);
  try { await c.removeChannel(channel); } catch { /* closing anyway */ }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  if (OUT) { mkdirSync(dirname(OUT), { recursive: true }); writeFileSync(OUT, JSON.stringify({ rig: "realtime-signals-live", at: new Date().toISOString(), run, trials: TRIALS, provenance: provenance(), results }, null, 2)); }
  process.exit(rigExitCode(results, EXPECTED_CHECKS));
}
}

main().catch((e) => { console.error(e); process.exit(2); });
