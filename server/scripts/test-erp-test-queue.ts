/**
 * The ERP test queue's fence and claim path, offline (rebuild task 1-0).
 *
 * Contacts neither Supabase nor Tally: every client here is handed a fake fetch
 * that records what would have been sent, and every push is a stub. It proves
 * the done-when's refusal half: the sandbox laptop's agent refuses the real
 * `push_queue`, its claim function and every production table before a request
 * leaves the process, and books only ZZ TEST jobs for the practice company.
 *
 *   npx tsx scripts/test-erp-test-queue.ts
 */
import "dotenv/config";
import {
  erpTestFence, erpTestQueueRefusal, erpTestQueueClient, supabaseClient, ERP_TEST_RPCS,
} from "../src/services/supabaseClient.js";
import { refuseSharedWrite } from "../src/services/tallyRole.js";
import {
  testJobRefusal, outcomeOf, runErpTestQueueOnce, memoryTestQueue, type TestJob,
} from "../src/services/erpTestQueueAgent.js";
import type { SafePushResult } from "../src/services/safePush.js";

let passed = 0, failed = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (cond) { passed++; console.log(`  ✓ ${label}${detail ? ` (${detail})` : ""}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ` (${detail})` : ""}`); }
};
const H = (s: string) => console.log(`\n── ${s}`);

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) { prev[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

const PROJECT = "https://abcdefghijklmnopqrst.supabase.co";
const SANDBOX_ON = {
  MKCP_TALLY_ROLE: "sandbox", MKCP_ERP_TEST_QUEUE: "on", MKCP_PRACTICE_COMPANY: "ZZ PRACTICE CO",
  MKCP_PRACTICE_COMPANY_GUID: "00000000-0000-0000-0000-000000000000", SUPABASE_URL: PROJECT,
  SUPABASE_SERVICE_KEY: "not-a-real-key", MKCP_OFFLINE: undefined,
};

(async () => {
  H("THE FENCE (pure)");
  const f = (path: string, method = "POST", host = PROJECT) => erpTestFence(`${host}${path}`, method, PROJECT);
  for (const fn of ERP_TEST_RPCS) ok(`allows POST rpc ${fn}`, f(`/rest/v1/rpc/${fn}`) === null);
  ok("refuses the real claim function claim_push_jobs", /not an ERP test-queue function/.test(f("/rest/v1/rpc/claim_push_jobs") ?? ""));
  ok("refuses approve_proposal", f("/rest/v1/rpc/approve_proposal") !== null);
  ok("refuses GET push_queue", f("/rest/v1/push_queue?select=*", "GET") !== null);
  ok("refuses POST push_queue", f("/rest/v1/push_queue", "POST") !== null);
  ok("refuses PATCH push_queue", f("/rest/v1/push_queue?id=eq.1", "PATCH") !== null);
  ok("refuses the mirror (tally_vouchers)", f("/rest/v1/tally_vouchers", "GET") !== null);
  ok("refuses mkcp_proposals and app_users", f("/rest/v1/mkcp_proposals", "GET") !== null && f("/rest/v1/app_users", "GET") !== null);
  ok("refuses storage and functions", f("/storage/v1/object/x", "POST") !== null && f("/functions/v1/x", "POST") !== null);
  ok("refuses another host", f("/rest/v1/rpc/claim_erp_test_jobs", "POST", "https://zzzzzzzzzzzzzzzzzzzz.supabase.co") !== null);
  ok("refuses an rpc by GET", f("/rest/v1/rpc/claim_erp_test_jobs", "GET") !== null);
  ok("allows GET on the test table", f("/rest/v1/erp_push_queue_test?id=eq.1", "GET") === null);
  ok("allows DELETE on the test table with is_test=eq.true", f("/rest/v1/erp_push_queue_test?id=in.(1)&is_test=eq.true", "DELETE") === null);
  ok("refuses DELETE without the is_test filter", f("/rest/v1/erp_push_queue_test?id=in.(1)", "DELETE") !== null);
  ok("L6: refuses a DELETE filtered only by is_test (would wipe other runs)", f("/rest/v1/erp_push_queue_test?is_test=eq.true", "DELETE") !== null);
  ok("L6: allows a DELETE naming one id", f("/rest/v1/erp_push_queue_test?id=eq.7f0c&is_test=eq.true", "DELETE") === null);
  ok("L6: allows a DELETE naming one idempotency key", f("/rest/v1/erp_push_queue_test?idempotency_key=eq.ZZTEST-E2E-1&is_test=eq.true", "DELETE") === null);
  ok("L6: allows a DELETE on a run's own key prefix", f("/rest/v1/erp_push_queue_test?idempotency_key=like.ZZTEST-R3-1730000000*&is_test=eq.true", "DELETE") === null);
  ok("L6: refuses a DELETE on the bare ZZTEST prefix", f("/rest/v1/erp_push_queue_test?idempotency_key=like.ZZTEST*&is_test=eq.true", "DELETE") !== null);
  ok("L6: refuses a DELETE with a wildcard id", f("/rest/v1/erp_push_queue_test?id=like.*&is_test=eq.true", "DELETE") !== null);
  ok("refuses PATCH and POST on the test table (functions only)", f("/rest/v1/erp_push_queue_test", "PATCH") !== null && f("/rest/v1/erp_push_queue_test", "POST") !== null);

  H("WHO MAY BUILD THE CLIENT");
  ok("a primary machine is refused", /sandbox laptop only/.test(erpTestQueueRefusal({ ...SANDBOX_ON, MKCP_TALLY_ROLE: "primary" }) ?? ""));
  ok("an unset role (defaults to primary) is refused", erpTestQueueRefusal({ ...SANDBOX_ON, MKCP_TALLY_ROLE: undefined }) !== null);
  ok("a sandbox without the switch is refused", /MKCP_ERP_TEST_QUEUE/.test(erpTestQueueRefusal({ ...SANDBOX_ON, MKCP_ERP_TEST_QUEUE: undefined }) ?? ""));
  ok("a sandbox without the practice GUID is refused", erpTestQueueRefusal({ ...SANDBOX_ON, MKCP_PRACTICE_COMPANY_GUID: "" }) !== null);
  ok("sandbox, switch on, practice company set: allowed", erpTestQueueRefusal(SANDBOX_ON) === null);

  H("THE PRODUCTION WRITE PATH STAYS SHUT");
  await withEnv(SANDBOX_ON, () => {
    ok("supabaseClient() is still null on the sandbox, switch or not", supabaseClient() === null);
    ok("the push agent still refuses to drain push_queue on the sandbox", refuseSharedWrite("Push-queue draining (test)") === true);
  });
  await withEnv({ ...SANDBOX_ON, MKCP_TALLY_ROLE: "primary" }, () => {
    let threw = "";
    try { erpTestQueueClient(); } catch (e) { threw = (e as Error).message; }
    ok("erpTestQueueClient() throws on a primary machine", /sandbox laptop only/.test(threw));
  });

  H("THE CLIENT SENDS NOTHING OUTSIDE THE FENCE");
  await withEnv(SANDBOX_ON, async () => {
    const sent: string[] = [];
    const fake = (async (input: any, init?: any) => {
      sent.push(`${init?.method ?? "GET"} ${typeof input === "string" ? input : input.url ?? String(input)}`);
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const c = erpTestQueueClient(fake);
    const a = await c.rpc("claim_push_jobs", { p_agent: "x", p_limit: 1, p_lease_seconds: 10 });
    ok("rpc claim_push_jobs comes back as an error", !!a.error, a.error?.message?.slice(0, 70));
    const b = await c.from("push_queue").select("*");
    ok("select on push_queue comes back as an error", !!b.error);
    const d = await c.from("push_queue").insert({ id: "x" });
    ok("insert on push_queue comes back as an error", !!d.error);
    ok("and none of the three reached the network", sent.length === 0, `${sent.length} sent`);
    await c.rpc("claim_erp_test_jobs", { p_agent: "x", p_limit: 1, p_lease_seconds: 10 });
    ok("claim_erp_test_jobs does reach the (fake) network", sent.length === 1 && /rpc\/claim_erp_test_jobs/.test(sent[0] ?? ""));
  });

  H("WHICH JOBS MAY BE BOOKED");
  const good: TestJob = {
    id: "j1", idempotency_key: "ZZTEST-1", label: "ZZ TEST contra", company: "ZZ PRACTICE CO", state: "queued", attempts: 0,
    payload: { voucherType: "Contra", date: "2026-11-05", voucherNumber: "ZZTEST900/1", narration: "ZZTEST900 test", remoteId: "MKCP|Contra|ZZTEST900/1", ledgerEntries: [] } as any,
  };
  await withEnv(SANDBOX_ON, () => {
    ok("a ZZ TEST job for the practice company passes", testJobRefusal(good) === null);
    ok("another company is refused", testJobRefusal({ ...good, company: "REAL CO" }) !== null);
    ok("a number without ZZTEST is refused", testJobRefusal({ ...good, payload: { ...good.payload, voucherNumber: "1867/26-27" } }) !== null);
    ok("no REMOTEID is refused", testJobRefusal({ ...good, payload: { ...good.payload, remoteId: undefined } }) !== null);
    ok("an Alter or Delete is refused", testJobRefusal({ ...good, payload: { ...good.payload, action: "Delete" } as any }) !== null);
  });
  ok("on a primary machine every job is refused", testJobRefusal(good, { ...process.env, ...SANDBOX_ON, MKCP_TALLY_ROLE: "primary" } as any) !== null);
  const base: SafePushResult = { ok: true, stage: "done", voucherId: "123", errors: [], warnings: [], differences: [] };
  ok("outcome: read back and matched is succeeded", outcomeOf(base) === "succeeded");
  ok("outcome: a difference is readback_differs", outcomeOf({ ...base, ok: false, stage: "verify", differences: ["amount"] }) === "readback_differs");
  ok("outcome: a refusal is failed", outcomeOf({ ...base, ok: false, stage: "guard", errors: ["no"] }) === "failed");
  ok("M2: created but not found on read-back is uncertain, never failed", outcomeOf({ ...base, ok: false, stage: "verify", errors: ["not found on read-back"] }) === "uncertain");
  ok("outcome: Tally refused at the push is failed", outcomeOf({ ...base, ok: false, stage: "push", errors: ["LINEERROR"] }) === "failed");

  H("THE CLAIM PATH (memory queue, stub push)");
  await withEnv(SANDBOX_ON, async () => {
    const q = memoryTestQueue([good, { ...good, id: "j2", idempotency_key: "ZZTEST-2", company: "REAL CO" }]);
    let pushes = 0;
    const r = await runErpTestQueueOnce(q, { tallyUrl: "http://127.0.0.1:1", limit: 5, push: async () => { pushes++; return base; } });
    ok("claims both", r.claimed === 2);
    ok("books the good one", q.rows.get("j1")!.state === "succeeded");
    ok("refuses the other company without pushing", q.rows.get("j2")!.state === "failed" && pushes === 1);
    const q2 = memoryTestQueue([{ ...good, id: "j3" }]);
    const r2 = await runErpTestQueueOnce(q2, { tallyUrl: "http://127.0.0.1:1", push: async () => { throw new Error("socket hang up"); } });
    ok("a throw after sent ends uncertain", q2.rows.get("j3")!.state === "uncertain" && r2.results[0].outcome === "uncertain");
    const again = await runErpTestQueueOnce(q2, { tallyUrl: "http://127.0.0.1:1", push: async () => { pushes++; return base; } });
    ok("an uncertain job is never claimed again", again.claimed === 0);
    const q3 = memoryTestQueue([{ ...good, id: "j4" }]);
    const realSent = q3.markSent;
    q3.markSent = async () => false;   // somebody cancelled or reclaimed it first
    const before = pushes;
    const r3 = await runErpTestQueueOnce(q3, { tallyUrl: "http://127.0.0.1:1", push: async () => { pushes++; return base; } });
    q3.markSent = realSent;
    ok("a job whose claim was lost is not pushed", r3.results[0].outcome === "lost-claim" && pushes === before);
  });
  await withEnv({ ...SANDBOX_ON, MKCP_TALLY_ROLE: "primary" }, async () => {
    let threw = false;
    try { await runErpTestQueueOnce(memoryTestQueue([good]), { tallyUrl: "http://127.0.0.1:1" }); } catch { threw = true; }
    ok("the claim path refuses to run on a primary machine", threw);
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
