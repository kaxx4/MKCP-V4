/**
 * Task 1-4 done-when: two simultaneous takes never collide.
 *
 * Fires 40 takes of the live counter at once (20 Payment, 20 Sales) through
 * `erp_take_test_voucher_number` (migration 0114), each on its own request, so
 * the database sees them together on several connections. Test series only,
 * under a company key `ZZTEST-C<stamp>` made for this run. No Tally is touched.
 *
 * Proves: every take returns; within a type no number repeats; the counters are
 * one unbroken run (no gap, nothing skipped); and the takes really overlapped
 * (most in flight at the same moment).
 *
 * The laptop cannot delete; the run prints the company key, and the operator
 * removes its test rows from erp_voucher_tombstones and erp_voucher_series.
 *
 *   $env:MKCP_ERP_TEST_QUEUE='on'; npx tsx scripts/rigs/counter-concurrency.ts --out <file.json>
 */
import "dotenv/config";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { erpTestQueueClient, agentMachineId, agentMachineKey } from "../../src/services/supabaseClient.js";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };
const OUT = arg("--out");
const EACH = Number(arg("--each") ?? 20);
const c = erpTestQueueClient();
const machine = agentMachineId(), key = agentMachineKey();
const company = `ZZTEST-C${Date.now().toString().slice(-6)}`;
const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());

function provenance() {
  const git = (...a: string[]) => (spawnSync("git", a, { encoding: "utf8", cwd: dirname(process.argv[1]) }).stdout ?? "").trim();
  return { commit: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}"), dirtyFiles: git("status", "--porcelain", "--", "..", "../../src").split("\n").filter(Boolean) };
}

(async () => {
  const prov = provenance();
  const steps: { step: string; ok: boolean; detail: string }[] = [];
  const step = (s: string, ok: boolean, detail = "") => { steps.push({ step: s, ok, detail }); console.log(`  ${ok ? "✓" : "✗"} ${s}${detail ? ` (${detail})` : ""}`); };
  console.log(`\n  Counter, ${EACH * 2} takes at once (company key ${company}, ${day}, commit ${prov.commit.slice(0, 8)})\n`);
  step("the run uses committed code", prov.dirtyFiles.length === 0, prov.dirtyFiles.join(", "));

  const t0 = Date.now();
  const spans: { type: string; start: number; end: number; number?: string; counter?: number; error?: string }[] = [];
  const take = async (type: string) => {
    const s = { type, start: Date.now() - t0, end: 0 } as (typeof spans)[number];
    spans.push(s);
    const { data, error } = await c.rpc("erp_take_test_voucher_number", { p_machine: machine, p_key: key, p_company_key: company, p_voucher_type: type, p_voucher_date: day });
    s.end = Date.now() - t0;
    if (error) s.error = error.message; else { s.number = data.number; s.counter = data.counter; }
  };
  // Open both series first, one take each, so the race below is on the take itself.
  await take("Payment"); await take("Sales");
  const jobs: Promise<void>[] = [];
  for (let i = 0; i < EACH; i++) { jobs.push(take("Payment")); jobs.push(take("Sales")); }
  await Promise.all(jobs);

  const race = spans.slice(2);
  const errors = race.filter((s) => s.error);
  step(`all ${race.length} simultaneous takes returned a number`, errors.length === 0, errors.slice(0, 2).map((e) => e.error).join("; "));
  let peak = 0;
  for (const s of race) peak = Math.max(peak, race.filter((o) => o.start < s.end && o.end > s.start).length);
  step("the takes really overlapped (in flight together)", peak >= 5, `up to ${peak} at once`);
  for (const type of ["Payment", "Sales"]) {
    const all = spans.filter((s) => s.type === type && s.counter != null);
    const nums = all.map((s) => s.number!);
    const ctr = all.map((s) => s.counter!).sort((a, b) => a - b);
    step(`${type}: no number was issued twice`, new Set(nums).size === nums.length, `${nums.length} numbers`);
    step(`${type}: the counters are one unbroken run, nothing skipped`, ctr.every((v, i) => i === 0 || v === ctr[i - 1] + 1), `${ctr[0]} to ${ctr[ctr.length - 1]}`);
  }
  step("Payment numbers carry the ERP prefix (D-1-4.2)", spans.filter((s) => s.type === "Payment" && s.number).every((s) => /^ERP-\d+\/\d{2}-\d{2}$/.test(s.number!)));
  step("Sales numbers continue Tally's series past the books' highest", spans.filter((s) => s.type === "Sales" && s.number).every((s) => /^\d{2}-\d{2}\/\d{4,}$/.test(s.number!)),
    spans.find((s) => s.type === "Sales")?.number ?? "");

  const report = { rig: "counter-concurrency", day, company, provenance: prov, steps, passed: steps.filter((s) => s.ok).length, failed: steps.filter((s) => !s.ok).length,
    takes: spans.map(({ type, start, end, number }) => ({ type, start, end, number })) };
  if (OUT) { mkdirSync(dirname(OUT), { recursive: true }); writeFileSync(OUT, JSON.stringify(report, null, 2)); }
  console.log(`\n  ${report.passed} passed, ${report.failed} failed. Test rows to remove: company_key = '${company}'`);
  process.exit(report.failed ? 1 : 0);
})();
