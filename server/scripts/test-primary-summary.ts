/**
 * Agent-ui lane, offline: the answer behind the agent window's "office computer" card (services/primarySummary.ts, GET /api/primary/summary).
 *   - the machine key is never in the answer (only its sha-256), even when a line, a note or a pin message carries it;
 *   - mode off / on / on-but-not-running are told apart, and the start problems are listed for the last;
 *   - "registered" is read from the preflight line, and is unknown (null) until a preflight has said;
 *   - the last time the loops LOOKED and the last time they DID something are two different fields;
 *   - the loops' own counters (PrimaryQueueLoop.lastWorkAt) move only when work was done.
 * No Tally and no database.
 *
 *   npx tsx scripts/test-primary-summary.ts
 */
import { buildPrimarySummary } from "../src/services/primarySummary.js";
import { keyHashOf } from "../src/services/primaryTools.js";
import { PrimaryQueueLoop } from "../src/services/primaryRunner.js";

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? `: ${detail}` : ""}`); }
};

const KEY = "ab".repeat(32);
const env = { MKCP_PRIMARY_MODE: "on", MKCP_AGENT_MACHINE_ID: "office-pc-1", MKCP_ERP_AGENT_KEY: KEY } as Record<string, string>;
const loop = (over: object = {}) => ({ running: true, rounds: 4, lastAt: "2026-11-15T10:00:00.000Z", lastNote: "idle", errors: 0, busy: false, lastWorkAt: null, ...over });
const mirror = (over: object = {}) => ({ ...loop(), alarms: [], holds: [], ...over });

(async () => {
  console.log("\n  the summary");
  const running = buildPrimarySummary({
    env, tallyUrl: "http://localhost:9000",
    primary: {
      queue: loop({ lastNote: `round failed: bad key ${KEY}`, lastWorkAt: "2026-11-15T09:00:00.000Z" }), mirror: mirror({ lastNote: "full:swapped", lastWorkAt: "2026-11-15T09:30:00.000Z", holds: [{}], alarms: [{}, {}] }),
      agent: { holder: "nonce", red: [`the journal said ${KEY}`], claimsPaused: null, pin: { ok: false, problem: `refused: not the pinned company ${KEY}`, at: "2026-11-15T10:00:00.000Z" } },
    },
    preflight: { lastAt: "2026-11-15T10:00:00.000Z", lastReady: false, lastError: null, lines: [
      { name: "the primary settings are complete", ok: true, detail: "" },
      { name: "the database is reachable and this machine's key is registered as primary", ok: false, detail: `machine ${KEY} is not registered` },
    ] },
    now: new Date("2026-11-15T10:01:00.000Z"),
  });
  const json = JSON.stringify(running);
  ok("the key is nowhere in the answer", !json.includes(KEY));
  ok("its sha-256 is there, and matches the registered hash", running.keyHash === keyHashOf(KEY));
  ok("mode on, machine named", running.mode === "on" && running.machineId === "office-pc-1");
  ok("not registered is read from the preflight line", running.registered === false);
  ok("the pin's verdict and problem are carried", running.pin.ok === false && /not the pinned company/.test(running.pin.problem ?? ""));
  ok("last looked and last worked are separate", running.claim.lastLookAt !== running.claim.lastWorkAt && running.claim.lastWorkAt === "2026-11-15T09:00:00.000Z");
  ok("mirror holds and alarms are counted", running.mirror.holds === 1 && running.mirror.alarms === 2 && running.mirror.lastWorkAt === "2026-11-15T09:30:00.000Z");
  ok("the lease holder is a yes or no, never the holder's id", running.claim.holdsLease === true && !json.includes("nonce"));

  const none = buildPrimarySummary({ env, tallyUrl: "http://localhost:9000", primary: null, preflight: null });
  ok("mode on without loops is on-but-not-running and lists why", none.mode === "on-not-running" && none.startProblems.length > 0);
  ok("with no preflight, registered and pin are unknown, not false", none.registered === null && none.pin.ok === null && none.preflight.ready === null);
  ok("no start problem line carries the key", !JSON.stringify(none).includes(KEY));

  const off = buildPrimarySummary({ env: { MKCP_AGENT_MACHINE_ID: "sandbox-laptop-1" }, tallyUrl: "http://localhost:9000", primary: null, preflight: null });
  ok("mode off is off, with no key hash when there is no key", off.mode === "off" && off.keyHash === null && off.startProblems.length === 0);
  ok("an unnamed machine is null, not the placeholder", buildPrimarySummary({ env: {}, tallyUrl: "x", primary: null, preflight: null }).machineId === null);

  const good = buildPrimarySummary({ env, tallyUrl: "x", primary: null, preflight: { lastAt: "t", lastReady: true, lastError: null, lines: [{ name: "the database is reachable and this machine's key is registered as primary", ok: true, detail: "" }] } });
  ok("registered true when that line passes", good.registered === true && good.preflight.ready === true);

  console.log("\n  the queue loop's last-work time");
  const idle = new PrimaryQueueLoop({ agent: { runOnce: async () => ({ held: true, settled: [], results: [] }) }, pollMs: 10_000, busyMs: 2000, log: () => {} });
  await idle.tick();
  ok("an idle round looks but does no work", idle.status.lastAt !== null && idle.status.lastWorkAt === null);
  const busy = new PrimaryQueueLoop({ agent: { runOnce: async () => ({ held: true, settled: [], results: [{ id: "1", key: "k", outcome: "succeeded", detail: "" }] }) }, pollMs: 10_000, busyMs: 2000, log: () => {} });
  await busy.tick();
  ok("a round that worked a job stamps the work time", busy.status.lastWorkAt !== null && busy.status.lastWorkAt === busy.status.lastAt);

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
