/**
 * Task 1-5, first half, on the dummy Tally: the ERP mirror sync end to end.
 *
 * Seven days ending on the dummy's latest voucher date (file 18 row 1-5) are
 * synced from the practice company into the ERP's own test mirror on live
 * (erp_mirror_rows under a ZZTEST company key, as test rows, names scrubbed),
 * step by step in erp_sync_runs. Then:
 *   - the same full sync again changes nothing;
 *   - an incremental with nothing changed reads nothing and keeps the mark;
 *   - one ZZTEST Contra is put in the dummy, and the incremental picks up
 *     exactly that voucher and moves the mark;
 *   - the Contra is swept; an incremental cannot see a deletion (that is the
 *     weekly full compare, A7), and the next full sync prunes it.
 * Everything is swept and this run's rows deleted. The tally_* tables are
 * never read or written; the office agent is not involved.
 *
 * Needs: sandbox role, local Tally with the practice company open, the Tally
 * slot, MKCP_ERP_TEST_QUEUE=on for this one process, this machine's key.
 *
 *   $env:MKCP_ERP_TEST_QUEUE='on'; npx tsx scripts/rigs/mirror-sync-dummy.ts --out <file.json>
 */
import "dotenv/config";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { guardScriptWrites } from "../../src/services/scriptWriteGuard.js";
guardScriptWrites("rigs/mirror-sync-dummy"); // writes only on a sandbox role against a local Tally
import { tallyPost } from "../../src/tally.js";
import { erpTestQueueClient, agentMachineId, agentMachineKey } from "../../src/services/supabaseClient.js";
import { practiceCompany } from "../../src/services/tallyRole.js";
import { safePush, vouchersOnDateXml } from "../../src/services/safePush.js";
import { readTag } from "../../src/services/xml.js";
import { runMirrorSync, supabaseMirrorStore, tallyMirrorReads, type MirrorSyncReport } from "../../src/services/erpMirrorSync.js";
import { rigPayload } from "./lib/simTally.js";
import { isSweepVoucher } from "../lib/testVoucherMatch.js";
import type { VoucherPayload } from "../../src/types.js";

const TALLY_URL = process.env.TALLY_URL || "http://localhost:9000";
const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };
const OUT = arg("--out");
const company = practiceCompany();
if (!company) { console.error("MKCP_PRACTICE_COMPANY is not set"); process.exit(2); }
const c = erpTestQueueClient();
const machine = agentMachineId(), key = agentMachineKey();
const stamp = Date.now().toString().slice(-6);           // digits only: the sweep matches ZZTEST<digits>/<n>
const companyKey = `ZZTEST-MIRROR-${stamp}`;
const store = supabaseMirrorStore(c, machine, key, companyKey, true);
const tally = tallyMirrorReads(TALLY_URL, company);
const post = (xml: string) => tallyPost(TALLY_URL, xml, 180_000, true) as Promise<string>;

function provenance() {
  const git = (...a: string[]) => (spawnSync("git", a, { encoding: "utf8", cwd: dirname(process.argv[1]) }).stdout ?? "").trim();
  return { commit: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}"), dirtyFiles: git("status", "--porcelain", "--", "..", "../../src").split("\n").filter(Boolean) };
}
const addDays = (iso: string, n: number) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

(async () => {
  const prov = provenance();
  const steps: { step: string; ok: boolean; detail: string; at: string }[] = [];
  const step = (s: string, ok: boolean, detail = "") => { steps.push({ step: s, ok, detail, at: new Date().toISOString() }); console.log(`  ${ok ? "✓" : "✗"} ${s}${detail ? ` (${detail})` : ""}`); };
  const runs: Record<string, MirrorSyncReport> = {};
  const mirrorCount = async () => {
    const { count, error } = await c.from("erp_mirror_rows").select("key", { count: "exact", head: true }).eq("company_key", companyKey).eq("is_test", true);
    if (error) throw new Error(`count: ${error.message}`);
    return count ?? 0;
  };
  const mark = async () => (await c.from("erp_sync_marks").select("alter_id,scope_from,scope_to").eq("company_key", companyKey).eq("is_test", true).maybeSingle()).data as { alter_id: number; scope_from: string; scope_to: string } | null;
  const sw = (r: MirrorSyncReport) => (r.swap ?? {}) as Record<string, any>;
  let day = "", pushed: VoucherPayload | null = null;

  console.log(`\n  ERP mirror sync on the dummy Tally (stamp ${stamp}, commit ${prov.commit.slice(0, 8)}, tree ${prov.tree.slice(0, 8)})\n`);
  step("the run uses committed code (no uncommitted change in the agent's src or scripts)", prov.dirtyFiles.length === 0, prov.dirtyFiles.join(", "));
  try {
    const top = await tally.highest();
    day = top.latestDate ?? "";
    const scope = { from: addDays(day, -6), to: day };
    step("found the dummy's latest voucher date and Tally's highest AlterID", !!day && top.alterId > 0, `latest ${day}, AlterID ${top.alterId}, ${top.count} vouchers`);

    // 1. a full sync of the seven days
    runs.full1 = await runMirrorSync({ store, tally, kind: "full", scope, scrub: true });
    const n1 = await mirrorCount();
    const { data: st1 } = await c.from("erp_sync_run_steps").select("seq,step,state,rows,ms").eq("run_id", runs.full1.run_id!).eq("is_test", true).order("seq");
    step("full sync of 7 days: swapped, every voucher read is in the ERP mirror", runs.full1.state === "swapped" && n1 === runs.full1.read - runs.full1.noGuid && n1 > 0,
      `${runs.full1.read} read, ${runs.full1.noGuid} without GUID, ${n1} in the mirror, ${runs.full1.tallyReads} Tally reads`);
    step("the run shows step by step in erp_sync_run_steps (mark, 7 days, staged, swapped)", (st1 ?? []).length === 10 && (st1 ?? []).every((s: any) => s.state === "ok"),
      (st1 ?? []).map((s: any) => `${s.seq} ${s.step}: ${s.rows ?? "-"} rows, ${s.ms ?? "-"} ms`).join(" | "));
    const m1 = await mark();
    step("the high-water mark is Tally's AlterID read before the reads, with the scope", m1?.alter_id === runs.full1.markCandidate && m1?.scope_from === scope.from && m1?.scope_to === scope.to, JSON.stringify(m1));
    const { data: sample } = await c.from("erp_mirror_rows").select("party,row").eq("company_key", companyKey).eq("is_test", true).limit(200);
    const names = (sample ?? []).flatMap((r: any) => [r.party, ...((r.row?.ledgers ?? []) as any[]).map((l) => l.ledger)]).filter(Boolean);
    step("names from the dummy are stored only as ZZ TEST stand-ins", names.every((x: string) => /^ZZ TEST\b/.test(x)), `${names.length} names checked`);

    // 2. the same full sync again
    runs.full2 = await runMirrorSync({ store, tally, kind: "full", scope, scrub: true });
    step("the same full sync again changes nothing", runs.full2.state === "swapped" && sw(runs.full2).inserted === 0 && sw(runs.full2).changed === 0 && sw(runs.full2).pruned === 0 && sw(runs.full2).unchanged === n1,
      JSON.stringify({ ...sw(runs.full2), changed_keys: undefined }));

    // 3. an incremental with nothing changed
    const before = (await mark())?.alter_id ?? -1;
    runs.inc0 = await runMirrorSync({ store, tally, kind: "incremental", scrub: true });
    step("an incremental with nothing changed in Tally reads nothing and keeps the mark", runs.inc0.state === "swapped" && runs.inc0.read === 0 && (await mark())?.alter_id === before,
      `read ${runs.inc0.read}, mark ${before} to ${(await mark())?.alter_id}`);

    // 4. one ZZTEST Contra in the dummy; the incremental finds exactly it
    pushed = { ...rigPayload(stamp, 1, day), label: "ZZ TEST 1-5 mirror" } as VoucherPayload;
    if (!isSweepVoucher({ number: pushed.voucherNumber ?? "", narration: pushed.narration ?? "" }, "ZZTEST")) throw new Error("refused: not a shape the sweep can remove");
    const pr = await safePush(TALLY_URL, company!, pushed);
    step("one ZZTEST Contra is put in the dummy on the scope's last day", pr.ok, pr.errors[0] ?? pushed.voucherNumber ?? "");
    runs.inc1 = await runMirrorSync({ store, tally, kind: "incremental", scrub: true });
    const { data: got } = await c.from("erp_mirror_rows").select("voucher_number,voucher_type,alter_id,ledger_total,row").eq("company_key", companyKey).eq("is_test", true).eq("voucher_number", pushed.voucherNumber!);
    const m2 = await mark();
    step("the incremental picks up exactly that voucher, and the mark moves past it",
      runs.inc1.state === "swapped" && runs.inc1.read === 1 && sw(runs.inc1).inserted === 1 && (got ?? []).length === 1 && (m2?.alter_id ?? 0) > before && (m2?.alter_id ?? 0) >= ((got ?? [])[0]?.alter_id ?? Infinity),
      `read ${runs.inc1.read}, inserted ${sw(runs.inc1).inserted}, ${JSON.stringify((got ?? [])[0] ? { ...(got as any[])[0], row: undefined } : null)}, mark ${before} to ${m2?.alter_id}`);
    step("the mirror holds one more voucher", (await mirrorCount()) === n1 + 1);
  } catch (e) {
    step("the run finished without an error", false, (e as Error).message);
  } finally {
    // 5. sweep, then: an incremental cannot see a deletion; the full sync prunes it
    const tsx = join(dirname(process.argv[1]), "..", "..", "node_modules", "tsx", "dist", "cli.mjs");
    const sweep = day ? spawnSync(process.execPath, [tsx, join(dirname(process.argv[1]), "..", "sweep-test-vouchers.ts"), "ZZTEST", day, "--yes"], { encoding: "utf8", env: process.env }) : null;
    let left: string[] = [];
    try {
      if (day) {
        const raw = await post(vouchersOnDateXml(company!, day, { voucherType: "Contra" }));
        left = [...raw.matchAll(/<VOUCHER\b[^>]*>[\s\S]*?<\/VOUCHER>/g)].map((m) => readTag(m[0], "VOUCHERNUMBER")).filter((n) => n.startsWith(`ZZTEST${stamp}/`));
      }
    } catch (e) { left = [`read failed: ${(e as Error).message}`]; }
    step("swept from the dummy: none of this run's numbers is left", !!sweep && sweep.status === 0 && left.length === 0, `sweep exit ${sweep?.status}, left ${left.length}`);
    let sweep2: ReturnType<typeof spawnSync> | null = null;
    try {
      if (pushed && runs.inc1?.state === "swapped" && sweep?.status === 0) {
        // 0117: deleting the newest voucher makes Tally's highest AlterID fall; the mark follows it down
        const markBefore = (await mark())?.alter_id ?? 0;
        runs.inc2 = await runMirrorSync({ store, tally, kind: "incremental", scrub: true });
        step("after the delete, Tally's highest AlterID fell and the mark follows it down; the incremental reads nothing (a deletion carries no AlterID, A7)",
          runs.inc2.state === "swapped" && runs.inc2.read === 0 && sw(runs.inc2).alter_id_fell === true && (await mark())?.alter_id === runs.inc2.markCandidate && (runs.inc2.markCandidate ?? 0) < markBefore,
          `mark ${markBefore} to ${(await mark())?.alter_id}, read ${runs.inc2.read}`);
        // a second voucher after the delete: the incremental must find it, whatever number Tally gives it
        const second = { ...rigPayload(stamp, 2, day), label: "ZZ TEST 1-5 mirror" } as VoucherPayload;
        const pr2 = await safePush(TALLY_URL, company!, second);
        runs.inc3 = await runMirrorSync({ store, tally, kind: "incremental", scrub: true });
        const { data: got2 } = await c.from("erp_mirror_rows").select("alter_id").eq("company_key", companyKey).eq("is_test", true).eq("voucher_number", second.voucherNumber!);
        const a2 = (got2 ?? [])[0]?.alter_id as number | undefined;
        step("a voucher made after the delete is picked up by the next incremental", pr2.ok && runs.inc3.state === "swapped" && runs.inc3.read === 1 && a2 !== undefined,
          `its AlterID ${a2}; the deleted voucher had ${markBefore}: Tally ${a2 !== undefined && a2 <= markBefore ? "REUSED a number at or below the old mark" : "did not reuse the number"}`);
        sweep2 = spawnSync(process.execPath, [tsx, join(dirname(process.argv[1]), "..", "sweep-test-vouchers.ts"), "ZZTEST", day, "--yes"], { encoding: "utf8", env: process.env });
        const raw2 = await post(vouchersOnDateXml(company!, day, { voucherType: "Contra" }));
        const left2 = [...raw2.matchAll(/<VOUCHER\b[^>]*>[\s\S]*?<\/VOUCHER>/g)].map((m) => readTag(m[0], "VOUCHERNUMBER")).filter((n) => n.startsWith(`ZZTEST${stamp}/`));
        step("swept again: none of this run's numbers is left", sweep2.status === 0 && left2.length === 0, `sweep exit ${sweep2.status}, left ${left2.length}`);
        const m = await mark();
        runs.full3 = await runMirrorSync({ store, tally, kind: "full", scope: { from: m!.scope_from, to: m!.scope_to }, scrub: true });
        step("the next full sync prunes both deleted vouchers, and the mirror is back to where it began", runs.full3.state === "swapped" && sw(runs.full3).pruned === 2 && sw(runs.full3).inserted === 0,
          `pruned ${sw(runs.full3).pruned}, mirror ${await mirrorCount()}`);
      }
    } catch (e) { step("the after-sweep syncs finished without an error", false, (e as Error).message); }
    const { data: cleaned, error: ce } = await c.rpc("erp_sync_test_cleanup", { p_machine: machine, p_key: key, p_company_key: companyKey });
    const remaining = ce ? -1 : await mirrorCount().catch(() => -1);
    const { count: runsLeft } = await c.from("erp_sync_runs").select("id", { count: "exact", head: true }).eq("company_key", companyKey).eq("is_test", true);
    step("this run's test rows are deleted (mirror rows, mark, runs, steps, staging)", !ce && remaining === 0 && runsLeft === 0, ce?.message ?? JSON.stringify(cleaned));
    const brief = (r?: MirrorSyncReport) => r && { run_id: r.run_id, state: r.state, read: r.read, staged: r.staged, noGuid: r.noGuid, markCandidate: r.markCandidate, tallyReads: r.tallyReads, swap: r.swap ? { ...r.swap, changed_keys: undefined } : null, error: r.error };
    const report = { rig: "mirror-sync-dummy", day, stamp, companyKey, provenance: prov, steps, runs: Object.fromEntries(Object.entries(runs).map(([k, r]) => [k, brief(r)])),
      passed: steps.filter((s) => s.ok).length, failed: steps.filter((s) => !s.ok).length, sweepTail: (sweep?.stdout ?? "").split("\n").slice(-6) };
    if (OUT) { mkdirSync(dirname(OUT), { recursive: true }); writeFileSync(OUT, JSON.stringify(report, null, 2)); }
    console.log(`\n  ${report.passed} passed, ${report.failed} failed`);
    process.exit(report.failed ? 1 : 0);
  }
})();
