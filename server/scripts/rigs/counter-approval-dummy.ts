/**
 * Task 1-4 review M6, on the dummy Tally: approval, take, push and read-back,
 * end to end, for numbers the counter issues.
 *
 * The approval and the take happen on the live database, where the ERP's own
 * functions run (erp_approve_proposal_as numbers the job from a TEST series
 * and tombstones the number). The laptop's fenced client may not call those
 * person functions, so the operator makes the three ZZ TEST jobs first, in a
 * console, and passes their ids here:
 *   - one Contra, numbered by a test series in the ERP's own shape;
 *   - two Journals whose drafts carried NO number.
 * This script then claims them with the sandbox agent, pushes them to the
 * dummy company, reads them back from Tally, and cleans up.
 *
 * Why the test series is "ZZTEST-ERP-{N}/{FY}" and not "ERP-{N}/{FY}": the
 * sweep deletes only numbers of the shape ZZTEST<digits>/ or ZZTEST<digits>-
 * with ZZTEST in the narration (isSweepVoucher), and a test job's number must
 * start with ZZTEST (testJobRefusal). A bare "ERP-5/26-27" would be refused by
 * the sandbox agent and could never be swept. "ZZTEST-ERP-5/26-27" is the same
 * shape with the mark in front: letters, a hyphen, the counter, a slash, the
 * year.
 *
 * Proves:
 *   1. Tally keeps the Contra's counter number exactly as sent, and the
 *      override read-back (numberOverride: verified by number) confirms it.
 *   2. Two unnumbered Journals make TWO vouchers (before 1-4 they shared one
 *      REMOTEID and the second altered the first).
 *   3. Both are swept; this run's test rows are deleted.
 *
 * Needs: sandbox role, local Tally with the practice company open, the Tally
 * slot, MKCP_ERP_TEST_QUEUE=on for this one process, this machine's key.
 *
 *   $env:MKCP_ERP_TEST_QUEUE='on'; npx tsx scripts/rigs/counter-approval-dummy.ts --jobs <contra>,<journal1>,<journal2> --stamp <digits> --out <file.json>
 */
import "dotenv/config";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { guardScriptWrites } from "../../src/services/scriptWriteGuard.js";
guardScriptWrites("rigs/counter-approval-dummy"); // writes only on a sandbox role against a local Tally
import { tallyPost } from "../../src/tally.js";
import { erpTestQueueClient, agentMachineId, agentMachineKey } from "../../src/services/supabaseClient.js";
import { practiceCompany } from "../../src/services/tallyRole.js";
import { vouchersOnDateXml } from "../../src/services/safePush.js";
import { readTag, escapeXml } from "../../src/services/xml.js";
import { ErpJobAgent, Journal, supabaseErpQueue, tallySeams } from "../../src/services/erpJobAgent.js";
import { indiaToday } from "./lib/simTally.js";
import { isSweepVoucher } from "../lib/testVoucherMatch.js";
import type { VoucherPayload } from "../../src/types.js";

const TALLY_URL = process.env.TALLY_URL || "http://localhost:9000";
const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };
const OUT = arg("--out");
const STAMP = arg("--stamp") ?? "";
const ids = (arg("--jobs") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const company = practiceCompany();
if (!company) { console.error("MKCP_PRACTICE_COMPANY is not set"); process.exit(2); }
if (ids.length !== 3 || !/^\d+$/.test(STAMP)) { console.error("usage: --jobs <contra>,<journal1>,<journal2> --stamp <digits>"); process.exit(2); }
const c = erpTestQueueClient();
const machine = agentMachineId(), key = agentMachineKey();
const q = supabaseErpQueue(c, machine, key);
const post = (url: string, xml: string) => tallyPost(url, xml, 180_000, true) as Promise<string>;
const seams = tallySeams(TALLY_URL, post);

function provenance() {
  const git = (...a: string[]) => (spawnSync("git", a, { encoding: "utf8", cwd: dirname(process.argv[1]) }).stdout ?? "").trim();
  return { commit: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}"), dirtyFiles: git("status", "--porcelain", "--", "..", "../../src").split("\n").filter(Boolean) };
}
type JobRow = { id: string; state: string; error: string | null; payload: VoucherPayload & { label?: string }; remote_id: string | null; master_id: string | null; result: Record<string, unknown> | null; proposal_id: string | null };

(async () => {
  const day = indiaToday();
  const prov = provenance();
  const steps: { step: string; ok: boolean; detail: string; at: string }[] = [];
  const step = (s: string, ok: boolean, detail = "") => { steps.push({ step: s, ok, detail, at: new Date().toISOString() }); console.log(`  ${ok ? "✓" : "✗"} ${s}${detail ? ` (${detail})` : ""}`); };
  const read = async (id: string) => (await c.from("erp_jobs").select("id,state,error,payload,remote_id,master_id,result,proposal_id").eq("is_test", true).eq("id", id).single()).data as JobRow;
  const dayOf = async (type: string) => {
    const raw = await post(TALLY_URL, vouchersOnDateXml(company!, day, { voucherType: type }));
    return [...raw.matchAll(/<VOUCHER\b[^>]*>[\s\S]*?<\/VOUCHER>/g)].map((m) => ({
      number: readTag(m[0], "VOUCHERNUMBER"), narration: readTag(m[0], "NARRATION"), masterId: readTag(m[0], "MASTERID"),
    }));
  };
  const before: JobRow[] = await Promise.all(ids.map(read));
  const [contra, j1, j2] = before;
  const mine = (n: string) => n.includes(`ZZTEST${STAMP}`);

  console.log(`\n  Approval, take, push and read-back on the dummy Tally (${day}, stamp ${STAMP}, commit ${prov.commit.slice(0, 8)}, tree ${prov.tree.slice(0, 8)})\n`);
  step("the run uses committed code (no uncommitted change in the agent's src or scripts)", prov.dirtyFiles.length === 0, prov.dirtyFiles.join(", "));
  try {
    step("the three jobs were made by approval and are queued",
      before.every((j) => j && j.state === "queued" && j.proposal_id), before.map((j) => j?.state ?? "missing").join(", "));
    const shape = /^ZZTEST-ERP-\d+\/\d{2}-\d{2}$/;
    step("the counter numbered all three at approval in the ERP's shape (ZZTEST-ERP-<n>/<yy-yy>), the Journals from drafts with no number",
      before.every((j) => shape.test(String(j.payload.voucherNumber ?? ""))), before.map((j) => j.payload.voucherNumber).join(", "));
    step("each REMOTEID is built from its number, as remoteIdFor builds it",
      before.every((j) => j.remote_id === `MKCP|${j.payload.voucherType}|${j.payload.voucherNumber}|2026-27` && j.payload.remoteId === j.remote_id),
      before.map((j) => j.remote_id).join(" "));
    step("the two Journals have two different numbers and REMOTEIDs", j1.remote_id !== j2.remote_id && j1.payload.voucherNumber !== j2.payload.voucherNumber);
    if (!isSweepVoucher({ number: String(contra.payload.voucherNumber), narration: String(contra.payload.narration) }, "ZZTEST")) throw new Error("refused: the Contra is not a shape the sweep can remove");

    const A = new ErpJobAgent({ queue: q, journal: new Journal(join(tmpdir(), `counter-approval-${STAMP}.jsonl`)), company: company!, ...seams, leaseSeconds: 30, jobLeaseSeconds: 120 });
    for (let i = 0; i < 12; i++) {
      const rep = await A.runOnce(3);
      if (!rep.held) await new Promise((r) => setTimeout(r, 3000));
      else if (rep.results.length === 0) break;
    }
    const after = await Promise.all(ids.map(read));
    const [ac, a1, a2] = after;
    step("all three were claimed, pushed and read back: succeeded", after.every((j) => j.state === "succeeded"), after.map((j) => `${j.state}${j.error ? `: ${j.error.slice(0, 80)}` : ""}`).join(" | "));

    const contras = (await dayOf("Contra")).filter((v) => v.number === contra.payload.voucherNumber);
    step(`Tally keeps the Contra's number exactly as sent ("${contra.payload.voucherNumber}")`, contras.length === 1 && contras[0].number === contra.payload.voucherNumber,
      contras.map((v) => JSON.stringify(v.number)).join(", ") || "not found");
    step("the override read-back confirmed it: verified by number, nothing renumbered",
      ac.state === "succeeded" && !/renumbered/i.test(String(ac.error ?? "")) && ((ac.result?.warnings as string[] | undefined) ?? []).every((w) => !/numbered .* instead/i.test(w)),
      JSON.stringify(ac.result?.warnings ?? []));
    const journals = (await dayOf("Journal")).filter((v) => mine(v.narration));
    step("two unnumbered Journals made TWO vouchers in Tally (different MASTERIDs)",
      journals.length === 2 && new Set(journals.map((v) => v.masterId)).size === 2 && a1.master_id !== a2.master_id,
      journals.map((v) => `${v.masterId} "${v.number}" ${v.narration}`).join(" | "));
  } catch (e) {
    step("the run finished without an error", false, (e as Error).message);
  } finally {
    // Journals: this company keeps no number on a Journal, so the sweep cannot see them; remove by their exact REMOTEID.
    let jDeleted = 0;
    for (const j of [j1, j2]) {
      if (!j?.remote_id) continue;
      const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Import</TALLYREQUEST><TYPE>Data</TYPE><ID>Vouchers</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${escapeXml(company!)}</SVCURRENTCOMPANY></STATICVARIABLES></DESC>
<DATA><TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER REMOTEID="${escapeXml(j.remote_id)}" VCHTYPE="Journal" ACTION="Delete"><DATE>${day.replace(/-/g, "")}</DATE><VOUCHERTYPENAME>Journal</VOUCHERTYPENAME></VOUCHER></TALLYMESSAGE></DATA></BODY></ENVELOPE>`;
      try { const res = await post(TALLY_URL, xml); jDeleted += Number(/<DELETED>(\d+)<\/DELETED>/.exec(res)?.[1] ?? 0); } catch { /* counted below */ }
    }
    const tsx = join(dirname(process.argv[1]), "..", "..", "node_modules", "tsx", "dist", "cli.mjs");
    const sweep = spawnSync(process.execPath, [tsx, join(dirname(process.argv[1]), "..", "sweep-test-vouchers.ts"), "ZZTEST", day, "--yes"], { encoding: "utf8", env: process.env });
    let left: string[] = [];
    try {
      left = [...(await dayOf("Contra")).filter((v) => v.number === contra?.payload.voucherNumber || mine(v.narration)).map((v) => v.number),
        ...(await dayOf("Journal")).filter((v) => mine(v.narration)).map((v) => `Journal ${v.masterId}`)];
    } catch (e) { left = [`read failed: ${(e as Error).message}`]; }
    step("swept from the dummy: the Journals by REMOTEID, the Contra by the sweep; none of this run's vouchers is left",
      sweep.status === 0 && left.length === 0, `journals deleted ${jDeleted}, sweep exit ${sweep.status}, left ${left.length}${left.length ? `: ${left.join(", ")}` : ""}`);
    const props = before.map((j) => j?.proposal_id).filter(Boolean) as string[];
    const d1 = await c.from("erp_jobs").delete().in("id", ids).eq("is_test", true);
    const d2 = await c.from("erp_proposals").delete().in("id", props).eq("is_test", true);
    step("this run's jobs and proposals are deleted (the tombstones and series rows are removed by the operator: the laptop cannot)",
      !d1.error && !d2.error, [d1.error?.message, d2.error?.message].filter(Boolean).join("; "));
    const report = { rig: "counter-approval-dummy", day, stamp: STAMP, jobs: ids, provenance: prov, steps,
      passed: steps.filter((s) => s.ok).length, failed: steps.filter((s) => !s.ok).length, sweepTail: (sweep.stdout ?? "").split("\n").slice(-6) };
    if (OUT) { mkdirSync(dirname(OUT), { recursive: true }); writeFileSync(OUT, JSON.stringify(report, null, 2)); }
    console.log(`\n  ${report.passed} passed, ${report.failed} failed`);
    process.exit(report.failed ? 1 : 0);
  }
})();
