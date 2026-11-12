/**
 * F6, agent half (D-M.112, D-M.187), offline: the agent respects `erp_filed_through()`.
 *
 * The agent keeps its own filed boundary (MKCP_FILED_THROUGH, else the statutory calendar) and takes the LATER of that
 * and the newest day a person recorded as filed. A recorded filing can only close more: it never moves back, a failed
 * read changes nothing, and a read of nothing changes nothing. Nothing here reaches Tally or Supabase.
 *
 *   cd server; npx tsx scripts/test-erp-filed-through.ts
 */
import {
  filedThroughOn, filedBoundaryFor, gstReturnFiledThrough, laterDate, setRecordedFiledThrough, recordedFiledThroughNow,
  resetRecordedFiledThroughForTests, backdatedPurchaseRefusals,
} from "../src/services/pushGuard.js";
import { ErpJobAgent, Journal } from "../src/services/erpJobAgent.js";
import { ERP_TEST_RPCS } from "../src/services/supabaseClient.js";
import type { TallyMasters } from "../src/services/tallyMasters.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memErpQueue } from "./rigs/lib/memErpQueue.js";
import { SimTally, sandboxForRig } from "./rigs/lib/simTally.js";

sandboxForRig();
let pass = 0, fail = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? `: ${detail}` : ""}`); }
};

console.log("the boundary:");
const today = new Date("2026-11-05T10:00:00+05:30");
const calendar = gstReturnFiledThrough(today); // the 5th: October's GSTR-1 is not due until the 11th, so the calendar closes September
ok("with nothing recorded the boundary is the calendar's", filedThroughOn(today) === calendar && calendar === "2026-09-30", `${filedThroughOn(today)} / ${calendar}`);
ok("a recorded date later than the calendar moves the boundary", setRecordedFiledThrough("2026-10-31") && filedThroughOn(today) === "2026-10-31");
ok("an earlier recorded date does not move it back", !setRecordedFiledThrough("2026-08-31") && recordedFiledThroughNow() === "2026-10-31" && filedThroughOn(today) === "2026-10-31");
ok("the same date again changes nothing", !setRecordedFiledThrough("2026-10-31"));
ok("nothing, junk and a non-date are ignored", !setRecordedFiledThrough(null) && !setRecordedFiledThrough("") && !setRecordedFiledThrough("soon") && !setRecordedFiledThrough("2026-02-31") && recordedFiledThroughNow() === "2026-10-31");
ok("a timestamp is read by its day", setRecordedFiledThrough("2026-11-30T00:00:00Z") && recordedFiledThroughNow() === "2026-11-30");
ok("laterDate takes the later and treats blank as nothing", laterDate("2026-09-30", "2026-10-31") === "2026-10-31" && laterDate("2026-09-30", "") === "2026-09-30" && laterDate("", "2026-10-31") === "2026-10-31");
ok("a Sales or Purchase is bound by the recorded day", filedBoundaryFor("Sales", today) === "2026-11-30" && filedBoundaryFor("Purchase", today) === "2026-11-30");
ok("money vouchers are still bound by none", filedBoundaryFor("Receipt", today) === "" && filedBoundaryFor("Payment", today) === "" && filedBoundaryFor("Journal", today) === "");
{
  const m = { ledgers: new Map(), ledgerLoose: new Map() } as unknown as TallyMasters;
  const p = { voucherType: "Purchase", action: "Create" as const, date: "2026-10-20", partyLedgerName: "X" } as Parameters<typeof backdatedPurchaseRefusals>[0];
  ok("a Purchase dated inside a recorded-filed month is refused before Tally, which the calendar alone would let through",
    backdatedPurchaseRefusals(p, m, filedBoundaryFor("Purchase", today)).some((e) => /already filed \(through 2026-11-30\)/.test(e)));
  resetRecordedFiledThroughForTests();
  ok("with nothing recorded the same Purchase passes this rule (the calendar closes only September)", backdatedPurchaseRefusals(p, m, filedBoundaryFor("Purchase", today)).length === 0);
}

console.log("\nthe agent reads it before it claims:");
const dir = mkdtempSync(join(tmpdir(), "erp-filed-"));
let jn = 0;
const mk = (feed: () => Promise<string | null>, extra: Record<string, unknown> = {}) => {
  const m = memErpQueue();
  const calls = { n: 0 };
  (m.queue as { filedThrough?: () => Promise<string | null> }).filedThrough = async () => { calls.n++; return feed(); };
  const sim = new SimTally();
  let off = 0;
  const agent = new ErpJobAgent({
    queue: m.queue, journal: new Journal(join(dir, `j${++jn}.jsonl`)), company: process.env.MKCP_PRACTICE_COMPANY!,
    push: (c, p) => sim.push("sim", c, p), find: async () => [], leaseSeconds: 90, jobLeaseSeconds: 120, wait: async () => {},
    now: () => Date.now() + off, maxSkewMs: 10_000_000, ...extra,
  });
  return { agent, calls, advance: (ms: number) => { off += ms; } };
};
(async () => {
  resetRecordedFiledThroughForTests();
  {
    const x = mk(async () => "2026-10-31");
    await x.agent.runOnce(1);
    ok("a round reads the recorded date and the guard's boundary moves", x.calls.n === 1 && recordedFiledThroughNow() === "2026-10-31" && x.agent.filedStatus.value === "2026-10-31" && x.agent.filedStatus.error === null);
    await x.agent.runOnce(1);
    ok("a second round inside the interval does not read again", x.calls.n === 1);
    x.advance(301_000);
    await x.agent.runOnce(1);
    ok("after the interval it reads again", x.calls.n === 2);
  }
  {
    const x = mk(async () => { throw new Error("erp_agent_filed_through: connection reset"); });
    await x.agent.runOnce(1);
    ok("a failed read changes nothing, never opens a period, and is noted", recordedFiledThroughNow() === "2026-10-31" && /connection reset/.test(x.agent.filedStatus.error ?? ""));
  }
  {
    const x = mk(async () => "2026-08-31");
    await x.agent.runOnce(1);
    ok("a read that returns an earlier day does not move the boundary back", recordedFiledThroughNow() === "2026-10-31");
    const y = mk(async () => null);
    await y.agent.runOnce(1);
    ok("a read of nothing (no filing recorded) changes nothing", recordedFiledThroughNow() === "2026-10-31" && y.agent.filedStatus.value === null && y.agent.filedStatus.error === null);
  }
  {
    const m = memErpQueue(); // no filedThrough on this queue
    const sim = new SimTally();
    const agent = new ErpJobAgent({ queue: m.queue, journal: new Journal(join(dir, `j${++jn}.jsonl`)), company: process.env.MKCP_PRACTICE_COMPANY!, push: (c, p) => sim.push("sim", c, p), find: async () => [], leaseSeconds: 90, jobLeaseSeconds: 120, wait: async () => {} });
    await agent.runOnce(1);
    ok("a queue without the door leaves the agent on its own boundary", agent.filedStatus.at === null);
  }
  ok("the sandbox fence lets the agent call the door and nothing broader", ERP_TEST_RPCS.includes("erp_agent_filed_through") && !ERP_TEST_RPCS.includes("erp_filed_through"));
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
