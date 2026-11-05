/**
 * Task 1-0 done-when, end to end: the laptop's agent, on the dummy Tally, takes a
 * job from `erp_push_queue_test`, books it, reads it back and marks it; the same
 * agent refuses the real `push_queue` and its claim function. Then it removes
 * the voucher from the dummy and its own queue row, and checks both are gone.
 *
 * Writes: one ZZ TEST row in `erp_push_queue_test` (live, ERP-only table, deleted
 * at the end) and one ZZTEST Contra in the dummy company (swept at the end).
 * Needs: sandbox role, local Tally with the practice company open, and
 * MKCP_ERP_TEST_QUEUE=on for this one process.
 *
 *   $env:MKCP_ERP_TEST_QUEUE='on'; npx tsx scripts/rigs/test-queue-e2e.ts --out <file.json>
 */
import "dotenv/config";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { guardScriptWrites } from "../../src/services/scriptWriteGuard.js";
guardScriptWrites("rigs/test-queue-e2e"); // writes only on a sandbox role against a local Tally
import { tallyPost } from "../../src/tally.js";
import { erpTestQueueClient, ERP_TEST_TABLE } from "../../src/services/supabaseClient.js";
import { practiceCompany } from "../../src/services/tallyRole.js";
import { vouchersOnDateXml } from "../../src/services/safePush.js";
import { readTag } from "../../src/services/xml.js";
import { runErpTestQueueOnce, supabaseTestQueue, TEST_AGENT_ID } from "../../src/services/erpTestQueueAgent.js";
import type { VoucherPayload } from "../../src/types.js";

const TALLY_URL = process.env.TALLY_URL || "http://localhost:9000";
const OUT = (() => { const i = process.argv.indexOf("--out"); return i >= 0 ? process.argv[i + 1] : null; })();
const indiaToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
const steps: { step: string; ok: boolean; detail: string; at: string }[] = [];
const step = (s: string, ok: boolean, detail = "") => {
  steps.push({ step: s, ok, detail, at: new Date().toISOString() });
  console.log(`  ${ok ? "✓" : "✗"} ${s}${detail ? ` (${detail})` : ""}`);
};

async function vouchersToday(company: string, day: string): Promise<{ number: string; narration: string; type: string }[]> {
  const xml = String(await tallyPost(TALLY_URL, vouchersOnDateXml(company, day), 60_000, true));
  return [...xml.matchAll(/<VOUCHER\b[^>]*>[\s\S]*?<\/VOUCHER>/g)].map((m) => ({
    number: readTag(m[0], "VOUCHERNUMBER").trim(), narration: readTag(m[0], "NARRATION").trim(), type: readTag(m[0], "VOUCHERTYPENAME").trim(),
  }));
}

(async () => {
  const company = practiceCompany();
  if (!company) { console.error("MKCP_PRACTICE_COMPANY is not set"); process.exit(2); }
  const c = erpTestQueueClient();   // throws unless sandbox + switch + practice GUID
  const day = indiaToday();
  const stamp = Date.now().toString().slice(-6);
  const number = `ZZTEST${stamp}/Q1`;
  console.log(`\n  ERP test queue, end to end (${day}, ${number})\n`);

  // 1. The production path stays shut, asked live through the same client.
  const r1 = await c.rpc("claim_push_jobs", { p_agent: TEST_AGENT_ID, p_limit: 1, p_lease_seconds: 10 });
  step("the real claim function claim_push_jobs is refused before sending", !!r1.error && /\[erpTestQueue\]/.test(r1.error.message ?? ""), r1.error?.message?.slice(0, 80));
  const r2 = await c.from("push_queue").select("id").limit(1);
  step("a read of the real push_queue is refused before sending", !!r2.error, r2.error?.message?.slice(0, 80));
  const r3 = await c.from("push_queue").update({ status: "dismissed" }).eq("id", "00000000-0000-0000-0000-000000000000");
  step("a write to the real push_queue is refused before sending", !!r3.error);

  // 2. Before: no voucher with this number in the dummy today.
  const before = await vouchersToday(company, day);
  step("dummy read before the push", true, `${before.length} voucher(s) dated ${day}, none numbered ${number}: ${!before.some((v) => v.number === number)}`);

  // 3. Queue the job.
  const payload: VoucherPayload = {
    voucherType: "Contra", date: day, voucherNumber: number, narration: `ZZTEST${stamp} erp test queue 1-0`,
    remoteId: `MKCP|Contra|${number}`, partyLedgerName: "HDFC BANK", isInvoice: false,
    ledgerEntries: [
      { ledgerName: "HDFC BANK", amount: 101, isDeemedPositive: true, isPartyLedger: false },
      { ledgerName: "Cash", amount: 101, isDeemedPositive: false, isPartyLedger: false },
    ],
  } as VoucherPayload;
  const key = `ZZTEST-1-0-${stamp}`;
  const enq = await c.rpc("enqueue_erp_test_job", { p_key: key, p_label: "ZZ TEST 1-0 contra", p_company: company, p_payload: payload });
  step("job queued in erp_push_queue_test", !enq.error && !!enq.data, enq.error?.message);
  const id = enq.data as string;

  // 4. The agent takes it, books it, reads it back, marks it.
  const run = await runErpTestQueueOnce(supabaseTestQueue(c), { tallyUrl: TALLY_URL, limit: 1 });
  const res = run.results.find((r) => r.id === id);
  step("the agent claimed the job", run.claimed >= 1 && !!res, `claimed ${run.claimed}`);
  step("booked on the dummy and read back equal", res?.outcome === "succeeded", `${res?.outcome}: ${res?.detail}`);
  const row = await c.from(ERP_TEST_TABLE).select("state, attempts, claimed_by, master_id, voucher_number, sent_at, error").eq("id", id).single();
  step("the queue row is marked succeeded", row.data?.state === "succeeded", JSON.stringify({ ...row.data, claimed_by: row.data?.claimed_by ? "this laptop" : null }));

  // 5. Independent read of the dummy: the voucher is in the books.
  const after = await vouchersToday(company, day);
  const found = after.filter((v) => v.number === number);
  step("an independent read finds exactly one voucher with the number", found.length === 1, `${found.length} found, type ${found[0]?.type ?? "-"}`);

  // 6. Clean up: sweep the dummy by what is in the books, then delete the queue row.
  const sweep = spawnSync(process.execPath, [join(dirname(process.argv[1]), "..", "..", "node_modules", "tsx", "dist", "cli.mjs"),
    join(dirname(process.argv[1]), "..", "sweep-test-vouchers.ts"), "ZZTEST", day, "--yes"], { encoding: "utf8", env: process.env });
  const left = (await vouchersToday(company, day)).filter((v) => v.number === number);
  step("swept from the dummy", sweep.status === 0 && left.length === 0, `sweep exit ${sweep.status}, ${left.length} left`);
  const del = await c.from(ERP_TEST_TABLE).delete().eq("id", id).eq("is_test", true);
  const gone = await c.from(ERP_TEST_TABLE).select("id").eq("idempotency_key", key);
  step("the test queue row is deleted", !del.error && (gone.data ?? []).length === 0, del.error?.message);

  const failed = steps.filter((s) => !s.ok).length;
  console.log(`\n  ${steps.length - failed} passed, ${failed} failed\n`);
  if (OUT) { mkdirSync(dirname(OUT), { recursive: true }); writeFileSync(OUT, JSON.stringify({ rig: "test-queue-e2e", day, number, steps, sweepTail: (sweep.stdout ?? "").split("\n").slice(-6) }, null, 2)); }
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
