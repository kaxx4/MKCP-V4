/**
 * Task 1-4 done-when on the dummy Tally: a number taken in Tally blocks the push.
 *
 * A Contra and a Sales invoice are put in the practice company first, standing
 * in for vouchers typed by hand in Tally. Then ERP test jobs carry the SAME
 * numbers (with different amounts, so an overwrite would show). The ERP agent
 * must refuse both before `sent`, and leave the earlier vouchers exactly as
 * they were. Two control jobs on fresh numbers (one Contra, one Sales) must go
 * through. Everything is swept at the end, and this run's test rows deleted.
 *
 * Needs: sandbox role, local Tally with the practice company open, the Tally
 * slot, MKCP_ERP_TEST_QUEUE=on for this one process, this machine's key.
 *
 *   $env:MKCP_ERP_TEST_QUEUE='on'; npx tsx scripts/rigs/counter-dummy.ts --out <file.json>
 */
import "dotenv/config";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { guardScriptWrites } from "../../src/services/scriptWriteGuard.js";
guardScriptWrites("rigs/counter-dummy"); // writes only on a sandbox role against a local Tally
import { tallyPost } from "../../src/tally.js";
import { erpTestQueueClient, agentMachineId, agentMachineKey } from "../../src/services/supabaseClient.js";
import { practiceCompany } from "../../src/services/tallyRole.js";
import { safePush, vouchersOnDateXml } from "../../src/services/safePush.js";
import { readTag } from "../../src/services/xml.js";
import { ErpJobAgent, Journal, supabaseErpQueue, tallySeams } from "../../src/services/erpJobAgent.js";
import { rigPayload, indiaToday } from "./lib/simTally.js";
import { dummySaleBuilder } from "./lib/dummySale.js";
import { isSweepVoucher } from "../lib/testVoucherMatch.js";
import type { VoucherPayload } from "../../src/types.js";

const TALLY_URL = process.env.TALLY_URL || "http://localhost:9000";
const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };
const OUT = arg("--out");
const company = practiceCompany();
if (!company) { console.error("MKCP_PRACTICE_COMPANY is not set"); process.exit(2); }
const c = erpTestQueueClient();
const machine = agentMachineId(), key = agentMachineKey();
const q = supabaseErpQueue(c, machine, key);
const post = (url: string, xml: string, timeoutMs = 180_000) => tallyPost(url, xml, timeoutMs, true) as Promise<string>;
const seams = tallySeams(TALLY_URL, post);
const LABEL = "ZZ TEST 1-4 counter";

function provenance() {
  const git = (...a: string[]) => (spawnSync("git", a, { encoding: "utf8", cwd: dirname(process.argv[1]) }).stdout ?? "").trim();
  return { commit: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}"), dirtyFiles: git("status", "--porcelain", "--", "..", "../../src").split("\n").filter(Boolean) };
}

(async () => {
  const day = indiaToday();
  const prov = provenance();
  const stamp = Date.now().toString().slice(-6);  // digits only: the sweep matches ZZTEST<digits>/<n>
  const steps: { step: string; ok: boolean; detail: string; at: string }[] = [];
  const step = (s: string, ok: boolean, detail = "") => { steps.push({ step: s, ok, detail, at: new Date().toISOString() }); console.log(`  ${ok ? "✓" : "✗"} ${s}${detail ? ` (${detail})` : ""}`); };
  const made: { job: string; proposal: string; request: string }[] = [];
  const contra = (n: number, amount?: number): VoucherPayload => {
    const p = { ...rigPayload(stamp, n, day), label: LABEL } as VoucherPayload;
    if (amount) p.ledgerEntries = p.ledgerEntries.map((e) => ({ ...e, amount }));
    return p;
  };
  async function enqueue(p: VoucherPayload, tag: string, kind = "contra") {
    const request = `ZZTEST-K${stamp}-${tag}`;
    const { data, error } = await c.rpc("erp_enqueue_test_job", { p_machine: machine, p_key: key, p_payload: p, p_request_id: request, p_kind: kind });
    if (error) throw new Error(`enqueue ${tag}: ${error.message}`);
    made.push({ job: data.job_id, proposal: data.proposal_id, request });
    return data.job_id as string;
  }
  const job = async (id: string) => (await c.from("erp_jobs").select("id,state,error").eq("is_test", true).eq("id", id).single()).data as { state: string; error: string | null };
  const inTally = async (p: VoucherPayload) => (await seams.find(company!, p)).length;
  const tsx = join(dirname(process.argv[1]), "..", "..", "node_modules", "tsx", "dist", "cli.mjs");

  console.log(`\n  Counter on the dummy Tally (${day}, stamp ${stamp}, commit ${prov.commit.slice(0, 8)}, tree ${prov.tree.slice(0, 8)})\n`);
  step("the run uses committed code (no uncommitted change in the agent's src or scripts)", prov.dirtyFiles.length === 0, prov.dirtyFiles.join(", "));
  if (!isSweepVoucher({ number: contra(1).voucherNumber ?? "", narration: contra(1).narration ?? "" }, "ZZTEST")) throw new Error("refused: not a shape the sweep can remove");
  try {
    const sale = await dummySaleBuilder(TALLY_URL, company!, day, stamp, LABEL);
    // 1. the "typed in Tally" vouchers
    const handC = contra(1), handS = sale(1);
    const r1 = await safePush(TALLY_URL, company!, handC);
    const r2 = await safePush(TALLY_URL, company!, handS);
    step("a Contra and a Sales invoice are already in Tally (standing in for hand typing)",
      r1.ok && r2.ok && (await inTally(handC)) === 1 && (await inTally(handS)) === 1, [r1.errors[0], r2.errors[0]].filter(Boolean).join("; "));

    // 2. ERP jobs on the same numbers, with other amounts; and two on fresh numbers
    const jobC = contra(1, 77), jobS = sale(1, 900), freeC = contra(2), freeS = sale(2);
    const idC = await enqueue(jobC, "C1"), idS = await enqueue(jobS, "S1", "sales_invoice");
    const idFC = await enqueue(freeC, "C2"), idFS = await enqueue(freeS, "S2", "sales_invoice");
    const A = new ErpJobAgent({ queue: q, journal: new Journal(join(tmpdir(), `counter-dummy-${stamp}.jsonl`)), company: company!, ...seams, leaseSeconds: 30, jobLeaseSeconds: 120 });
    for (let i = 0; i < 12; i++) {
      const rep = await A.runOnce(1);
      if (!rep.held) await new Promise((r) => setTimeout(r, 3000));
      else if (rep.results.length === 0) break;
    }
    const [sC, sS, sFC, sFS] = await Promise.all([idC, idS, idFC, idFS].map(job));
    step("a Contra job on a number Tally already holds is refused before sent", sC.state === "failed" && /already used in Tally/.test(sC.error ?? ""), sC.error?.slice(0, 110) ?? sC.state);
    step("Sales: an invoice job on a number Tally already holds is refused before sent", sS.state === "failed" && /Sales number .* is already used in Tally/.test(sS.error ?? ""), sS.error?.slice(0, 110) ?? sS.state);
    step("the vouchers already in Tally are untouched (found once, at their own amounts; the jobs' amounts are not there)",
      (await inTally(handC)) === 1 && (await inTally(handS)) === 1 && (await inTally(jobC)) === 0 && (await inTally(jobS)) === 0);
    step("a Contra job on a free number goes through, booked once", sFC.state === "succeeded" && (await inTally(freeC)) === 1, sFC.error ?? sFC.state);
    step("Sales: an invoice job on a free number goes through, booked once", sFS.state === "succeeded" && (await inTally(freeS)) === 1, sFS.error ?? sFS.state);
  } catch (e) {
    step("the run finished without an error", false, (e as Error).message);
  } finally {
    const sweep = spawnSync(process.execPath, [tsx, join(dirname(process.argv[1]), "..", "sweep-test-vouchers.ts"), "ZZTEST", day, "--yes"], { encoding: "utf8", env: process.env });
    const ours = new RegExp(`^ZZTEST${stamp}/`);
    let left: string[] = [];
    try {
      for (const t of ["Contra", "Sales"]) {
        const raw = await post(TALLY_URL, vouchersOnDateXml(company!, day, { voucherType: t }));
        left = left.concat([...raw.matchAll(/<VOUCHER\b[^>]*>[\s\S]*?<\/VOUCHER>/g)].map((m) => readTag(m[0], "VOUCHERNUMBER")).filter((n) => ours.test(n)));
      }
    } catch (e) { left = [`read failed: ${(e as Error).message}`]; }
    step("swept from the dummy: none of this run's numbers is left", sweep.status === 0 && left.length === 0, `sweep exit ${sweep.status}, left ${left.length}${left.length ? `: ${left.slice(0, 5).join(", ")}` : ""}`);
    const ids = made.map((m) => m.job).filter(Boolean);
    const d1 = ids.length ? await c.from("erp_jobs").delete().in("id", ids).eq("is_test", true) : { error: null };
    const d2 = made.length ? await c.from("erp_proposal_requests").delete().in("request_id", made.map((m) => m.request)).eq("is_test", true) : { error: null };
    const d3 = made.length ? await c.from("erp_proposals").delete().in("id", made.map((m) => m.proposal)).eq("is_test", true) : { error: null };
    step("this run's test rows are deleted", !d1.error && !d2.error && !d3.error, [d1.error?.message, d2.error?.message, d3.error?.message].filter(Boolean).join("; "));
    const report = { rig: "counter-dummy", day, stamp, provenance: prov, steps, passed: steps.filter((s) => s.ok).length, failed: steps.filter((s) => !s.ok).length,
      sweepTail: (sweep.stdout ?? "").split("\n").slice(-6) };
    if (OUT) { mkdirSync(dirname(OUT), { recursive: true }); writeFileSync(OUT, JSON.stringify(report, null, 2)); }
    console.log(`\n  ${report.passed} passed, ${report.failed} failed`);
    process.exit(report.failed ? 1 : 0);
  }
})();
