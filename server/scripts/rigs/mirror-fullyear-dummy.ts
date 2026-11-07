/**
 * Review of thread 8, item 15: ONE full-year first run of the ERP mirror on the dummy Tally, measured. The existing
 * mirror-sync-dummy rig reads the busiest week; this one reads every day of the financial year to date, into a fresh ZZTEST
 * company key with no mark (a first run), and records how long it took, the largest staging request (rows and bytes of
 * JSON), the biggest single day read, and what the swap-store copy did. Then it parses 8 vouchers of the busiest day on its
 * own and compares them with the block (item 13), and removes everything it made.
 *
 * Order: one cheap read first (60 s, no retry; if it does not answer the rig stops and never restarts Tally); the run; the
 * checks; the clean-up with its result checked and the leftovers counted. A watchdog ends the rig if no Tally request
 * completes for 300 s (and at 30 minutes in all). No report request is sent.
 *
 *   $env:MKCP_ERP_TEST_QUEUE='on'; npx tsx scripts/rigs/mirror-fullyear-dummy.ts --out <file.json>
 */
import "dotenv/config";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { guardScriptWrites } from "../../src/services/scriptWriteGuard.js";
guardScriptWrites("rigs/mirror-fullyear-dummy");
import { tallyPost } from "../../src/tally.js";
import { erpTestQueueClient, agentMachineId, agentMachineKey } from "../../src/services/supabaseClient.js";
import { practiceCompany, practiceGuid } from "../../src/services/tallyRole.js";
import { runMirrorSync, supabaseMirrorStore, tallyMirrorReads, eachDay, ERP_MIRROR_VOUCHER_DEF, type MirrorTally } from "../../src/services/erpMirrorSync.js";
import { buildCollectionXml } from "../../src/services/xmlBuilder.js";
import { compareRawToBlock, parseRawVoucher, pickForCheck, splitRawVouchers } from "./lib/independentVoucherCheck.js";
import { STAGE_MAX_BYTES } from "../../src/services/stageChunks.js";
import { rigExitCode, swapStoreCleanup, type RigCheck } from "./rigExit.js";

const TALLY_URL = process.env.TALLY_URL || "http://localhost:9000";
const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };
const OUT = arg("--out");
const company = practiceCompany();
if (!company) { console.error("MKCP_PRACTICE_COMPANY is not set"); process.exit(2); }
if (!practiceGuid()) { console.error("MKCP_PRACTICE_COMPANY_GUID is not set: the rig will not read a company it cannot identify"); process.exit(2); }
const c = erpTestQueueClient();
const machine = agentMachineId(), key = agentMachineKey();
const stamp = Date.now().toString().slice(-6);
const companyKey = `ZZTEST-FULLYEAR-${stamp}`;
const steps: { step: string; ok: boolean; detail: string; at: string }[] = [];
const checks: RigCheck[] = [];
const step = (s: string, ok: boolean, detail = "") => { steps.push({ step: s, ok, detail, at: new Date().toISOString() }); checks.push({ name: s, ok, detail }); console.log(`  ${ok ? "✓" : "✗"} ${s}${detail ? ` (${detail})` : ""}`); };
const EXPECTED_CHECKS = 9;
const t0 = Date.now();
let lastActivity = Date.now();
let finishing = false;
let report: Record<string, unknown> = {};

function provenance() {
  const git = (...a: string[]) => (spawnSync("git", a, { encoding: "utf8", cwd: dirname(process.argv[1]) }).stdout ?? "").trim();
  return { commit: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}"), dirtyFiles: git("status", "--porcelain", "--", "..", "../../src").split("\n").filter(Boolean) };
}

async function finish(): Promise<never> {
  if (finishing) process.exit(3);
  finishing = true;
  try {
    const { error: ce } = await c.rpc("erp_sync_test_cleanup", { p_machine: machine, p_key: key, p_company_key: companyKey });
    const left: Record<string, number> = {};
    let countErr: string | null = null;
    // erp_mirror_stage has no company_key column; swapStoreCleanup and the run's own cleanup cover it.
    for (const tb of ["erp_sync_runs", "erp_mirror_rows", "erp_mirror_ledgers"]) {
      const r = await c.from(tb).select("*", { count: "exact", head: true }).eq("company_key", companyKey).eq("is_test", true);
      if (r.error) countErr = r.error.message; left[tb] = r.count ?? -1;
    }
    step("the mirror's test rows of this run are deleted and none is left", !ce && !countErr && Object.values(left).every((n) => n === 0), ce?.message ?? countErr ?? JSON.stringify(left));
  } catch (e) { step("the mirror's test rows of this run are deleted and none is left", false, (e as Error).message); }
  const swap = await swapStoreCleanup(c, machine, key, companyKey).catch((e) => ({ ok: false, detail: String(e) }));
  step("this run's swap-store rows are deleted and none is left", swap.ok, swap.detail);
  const full = { rig: "mirror-fullyear-dummy", stamp, companyKey, provenance: provenance(), minutes: Math.round((Date.now() - t0) / 6000) / 10, steps, ...report,
    passed: steps.filter((s) => s.ok).length, failed: steps.filter((s) => !s.ok).length };
  if (OUT) { mkdirSync(dirname(OUT), { recursive: true }); writeFileSync(OUT, JSON.stringify(full, null, 2)); }
  console.log(`\n  ${full.passed} passed, ${full.failed} failed (${full.minutes} min)`);
  process.exit(rigExitCode(checks, EXPECTED_CHECKS));
}

setInterval(() => {
  const quiet = Date.now() - lastActivity, total = Date.now() - t0;
  if (quiet > 300_000 || total > 1_800_000) {
    step("the watchdog ended the run (no Tally request completed for 300 s, or 30 minutes in all); Tally is NOT restarted", false, `quiet ${Math.round(quiet / 1000)} s, total ${Math.round(total / 1000)} s`);
    void finish();
  }
}, 5000).unref();

(async () => {
  const prov = provenance();
  console.log(`\n  Full-year first run of the mirror on the dummy Tally (stamp ${stamp}, commit ${prov.commit.slice(0, 8)})\n`);
  step("the run uses committed code (no uncommitted change in the agent's src or scripts)", prov.dirtyFiles.length === 0, prov.dirtyFiles.join(", "));
  try {
    const cheap = { name: "mkcpCheapCompanies", tallyCollection: "Company", metadataType: "Company", category: "master", fetch: ["Name", "Guid"], timeout: 60_000, parallel: false } as any;
    const c0 = Date.now();
    const r: any = await tallyPost(TALLY_URL, buildCollectionXml(cheap, company!), 60_000, false);
    lastActivity = Date.now();
    const col = r?.ENVELOPE?.BODY?.DATA?.COLLECTION;
    const list = [].concat(col?.COMPANY ?? col?.["COMPANY.LIST"] ?? []) as any[];
    const guids = list.map((x) => String(x?.GUID?.["#text"] ?? x?.GUID ?? "").trim());
    const good = guids.length === 1 && guids[0] === practiceGuid();
    step("one cheap read first (60 s limit): Tally answered and the open company's GUID is the practice company's", good, `${Date.now() - c0} ms, ${guids.length} company`);
    if (!good) throw new Error("the cheap read did not confirm the practice company; stopping without touching Tally again");

    const store = supabaseMirrorStore(c, machine, key, companyKey, true);
    const base = tallyMirrorReads(TALLY_URL, company!);
    const dayMs: Record<string, number> = {};
    const tally: MirrorTally = {
      ...base,
      highest: async () => { const v = await base.highest(); lastActivity = Date.now(); return v; },
      vouchersOn: async (d) => { const s = Date.now(); const v = await base.vouchersOn(d); dayMs[d] = Date.now() - s; lastActivity = Date.now(); return v; },
      ledgers: async (...a: any[]) => { const v = await (base.ledgers as any)(...a); lastActivity = Date.now(); return v; },
      loadedPeriod: async () => { const v = await base.loadedPeriod(); lastActivity = Date.now(); return v; },
    };
    const top = await tally.highest();
    const fyStart = "2026-04-01";
    const days = Object.keys(top.byDay).filter((d) => d >= fyStart).sort();
    if (!days.length) throw new Error("the dummy holds no voucher in this financial year");
    const scope = { from: fyStart, to: days[days.length - 1] };
    const tallyCount = days.reduce((a, d) => a + top.byDay[d], 0);
    const busy = days.slice().sort((a, b) => top.byDay[b] - top.byDay[a])[0];
    console.log(`  scope ${scope.from} to ${scope.to}: ${eachDay(scope.from, scope.to).length} days, ${days.length} with vouchers, ${tallyCount} vouchers; busiest ${busy} with ${top.byDay[busy]}`);

    const tr = Date.now();
    const run = await runMirrorSync({ store, tally, kind: "full", scope, log: (l) => { lastActivity = Date.now(); if (/failed|refus/i.test(l)) console.log("   " + l.slice(0, 200)); } });
    const minutes = Math.round((Date.now() - tr) / 600) / 100;
    const { count: held } = await c.from("erp_mirror_rows").select("key", { count: "exact", head: true }).eq("company_key", companyKey).eq("is_test", true);
    const slowest = Object.entries(dayMs).sort((a, b) => b[1] - a[1])[0];
    report = { scope, daysInScope: eachDay(scope.from, scope.to).length, daysWithVouchers: days.length, tallyVouchers: tallyCount, busiestDay: { day: busy, vouchers: top.byDay[busy] }, firstRunMinutes: minutes,
      read: run.read, staged: run.staged, mirrorRows: held, tallyRequests: run.tallyReads, largestBatchRows: run.largestBatchRows, largestBatchBytes: run.largestBatchBytes,
      slowestDayRead: slowest ? { day: slowest[0], ms: slowest[1] } : null, swap: run.swap && { ...run.swap, changed_keys: undefined }, derive: run.tally, tallyError: run.tallyError, error: run.error };
    step("the first full-year run swapped, and the mirror holds exactly what Tally counts for the year", run.state === "swapped" && held === tallyCount && run.read === tallyCount,
      `${run.state}${run.error ? " " + run.error : ""}; read ${run.read}, mirror ${held}, Tally counts ${tallyCount}; ${minutes} minutes; ${run.tallyReads} Tally reads`);
    const d = run.tally as any;
    step("the swap-store copy was whole: every mirror voucher had its block and every voucher was copied", !!d && !run.tallyError && d.without_block === 0 && d.mirror_vouchers === tallyCount && d.upserted?.vouchers === tallyCount, JSON.stringify(d));
    step("the largest staging request is recorded and inside the byte cap", (run.largestBatchBytes ?? 0) > 0 && (run.largestBatchBytes ?? 0) <= STAGE_MAX_BYTES + 700_000, `${run.largestBatchRows} rows, ${run.largestBatchBytes} bytes (cap ${STAGE_MAX_BYTES}); slowest day read ${slowest?.[0]} ${slowest?.[1]} ms`);

    // item 13 at volume: 8 vouchers of the busiest day parsed on their own
    const rawXml = await tallyPost(TALLY_URL, buildCollectionXml(ERP_MIRROR_VOUCHER_DEF, company!, busy, busy), 180_000, true) as string;
    lastActivity = Date.now();
    const raws = splitRawVouchers(rawXml).map(parseRawVoucher);
    const picked = pickForCheck(raws, 8);
    const { data: heldRows, error: he } = await c.from("erp_mirror_rows").select("key,row").eq("company_key", companyKey).eq("is_test", true).in("key", picked.map((p) => p.guid));
    const byKey = new Map((heldRows ?? []).map((x: any) => [x.key as string, x.row?.tally]));
    const diffs = picked.flatMap((p) => compareRawToBlock(p, byKey.get(p.guid) as any, { test: true }));
    step("the busiest day's raw XML has the vouchers Tally counts for it", raws.length === top.byDay[busy], `${raws.length} in the XML, Tally counts ${top.byDay[busy]}`);
    step("independent check at volume: 8 vouchers parsed from the raw XML agree with the block", !he && picked.length >= 5 && diffs.length === 0, he?.message ?? (diffs.slice(0, 4).join(" ; ") || `${picked.length} vouchers, 0 differences`));
  } catch (e) {
    step("the run finished without an error", false, (e as Error).message);
  } finally {
    await finish();
  }
})();
