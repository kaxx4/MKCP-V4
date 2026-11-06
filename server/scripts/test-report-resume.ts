/**
 * Report jobs left by an agent that stopped (rebuild task 1-5, E3 and E6).
 *
 * E3: a job left "running" by the previous boot is asked again, once, and its
 * result is stored. E6: a job "running" past REPORT_STUCK_MS that this process
 * is not running is closed as an error, with why. Offline: the database is an
 * in-memory stand-in for tally_report_jobs and tally_report_snapshots, and
 * Tally is the socket mock (tallyMock); nothing reaches a network.
 *
 *   npx tsx scripts/test-report-resume.ts
 */
import "dotenv/config";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ReportRunner, planOrphanReports, reportResumeLog, reportClaimLog, REPORT_RESUME_MAX, REPORT_STUCK_MS, type RunningReportJob } from "../src/services/reportRunner.js";
import { installMock, uninstallMock } from "../src/services/tallyMock.js";

let passed = 0, failed = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (cond) { passed++; console.log(`    \x1b[32m✓\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`); }
  else { failed++; console.log(`    \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`); }
};
const H = (t: string) => console.log(`\n\x1b[1m${t}\x1b[0m`);

/** A tiny stand-in for the Supabase query builder: eq, is, in, order, limit, select, update, upsert. */
function memDb(tables: Record<string, any[]>) {
  const writes: { table: string; op: string; patch?: any; filters: string }[] = [];
  const from = (table: string) => {
    const filters: [string, string, any][] = [];
    let op: "select" | "update" | "upsert" = "select", patch: any = null, lim: number | null = null, orderBy: string | null = null;
    const rows = () => (tables[table] ??= []);
    const match = (r: any) => filters.every(([f, k, v]) => k === "eq" ? r[f] === v : k === "is" ? (r[f] ?? null) === v : k === "in" ? (v as any[]).includes(r[f]) : true);
    const b: any = {
      select() { return b; }, eq(f: string, v: any) { filters.push([f, "eq", v]); return b; }, is(f: string, v: any) { filters.push([f, "is", v]); return b; },
      in(f: string, v: any[]) { filters.push([f, "in", v]); return b; }, order(f: string) { orderBy = f; return b; }, limit(n: number) { lim = n; return b; },
      update(p: any) { op = "update"; patch = p; return b; },
      upsert(p: any) { op = "upsert"; patch = p; return b; },
      then(res: (v: any) => void, rej: (e: any) => void) {
        try {
          if (op === "update") { const hit = rows().filter(match); hit.forEach((r) => Object.assign(r, patch)); writes.push({ table, op, patch, filters: JSON.stringify(filters) }); return res({ data: hit, error: null }); }
          if (op === "upsert") { const i = rows().findIndex((r) => r.company === patch.company && r.report === patch.report); if (i >= 0) rows()[i] = patch; else rows().push(patch); writes.push({ table, op, patch, filters: "" }); return res({ data: null, error: null }); }
          let out = rows().filter(match);
          if (orderBy) out = [...out].sort((x, y) => String(x[orderBy!]).localeCompare(String(y[orderBy!])));
          if (lim !== null) out = out.slice(0, lim);
          return res({ data: out.map((r) => ({ ...r })), error: null });
        } catch (e) { rej(e); }
      },
    };
    return b;
  };
  return { client: { from } as any, writes, tables };
}

const memClaims = (ids: string[] = []) => { const s = new Set(ids); return { has: (id: string) => s.has(id), add: (id: string) => { s.add(id); }, s }; };

const memResumes = (start: Record<string, number> = {}) => {
  const m = new Map(Object.entries(start));
  return { count: (id: string) => m.get(id) ?? 0, add: (id: string) => { m.set(id, (m.get(id) ?? 0) + 1); }, m };
};

(async () => {
  const NOW = Date.parse("2026-11-06T10:00:00Z");
  const ago = (ms: number) => new Date(NOW - ms).toISOString();

  H("THE PLAN (pure)");
  const jobs: RunningReportJob[] = [
    { id: "A", status: "running", started_at: ago(60_000) },
    { id: "B", status: "running", started_at: ago(REPORT_STUCK_MS + 1) },
    { id: "C", status: "done", started_at: ago(REPORT_STUCK_MS * 3) },
    { id: "D", status: "running", started_at: null },
  ];
  let p = planOrphanReports(NOW, true, jobs, () => 0, null);
  ok("E3: at boot every running job from the earlier boot is asked again, young or old", JSON.stringify(p.resume) === JSON.stringify(["A", "B", "D"]) && p.fail.length === 0);
  p = planOrphanReports(NOW, true, jobs, (id) => (id === "B" ? REPORT_RESUME_MAX : 0), null);
  ok("E3: a job already asked again the most times is closed as an error at boot, not looped", p.resume.join() === "A,D" && p.fail.map((f) => f.id).join() === "B" && /already been asked again 1 time/.test(p.fail[0].why));
  p = planOrphanReports(NOW, false, jobs, () => 0, null);
  ok("E6: after boot only a job running past the stuck time (or with no start) is closed; a younger one is left", p.resume.length === 0 && p.fail.map((f) => f.id).join() === "B,D" && /No result was written within 20 minutes/.test(p.fail[0].why));
  p = planOrphanReports(NOW, true, jobs, () => 0, "A");
  ok("the job this process is running is never touched", !p.resume.includes("A") && !p.fail.some((f) => f.id === "A"));
  ok("a finished job is never touched", ![...planOrphanReports(NOW, true, jobs, () => 0, null).resume, ...planOrphanReports(NOW, false, jobs, () => 0, null).fail.map((f) => f.id)].includes("C"));
  ok("the stuck time is well above the slow reports' 420 s timeout", REPORT_STUCK_MS >= 2 * 420_000);

  H("THE RESUME COUNT ON DISK");
  const dir = mkdtempSync(join(tmpdir(), "report-resume-"));
  try {
    const log = reportResumeLog(join(dir, "r.jsonl"));
    ok("no file yet: no resumes", log.count("J1") === 0);
    log.add("J1");
    ok("one resume is counted, and only for that job", log.count("J1") === 1 && log.count("J2") === 0);
    ok("a new process reading the same file sees it (counted on disk, not in memory)", reportResumeLog(join(dir, "r.jsonl")).count("J1") === 1);
    writeFileSync(join(dir, "bad.jsonl"), "{not json\n");
    ok("an unreadable file counts as already resumed: failing a job is safe, looping is not", reportResumeLog(join(dir, "bad.jsonl")).count("J9") === REPORT_RESUME_MAX);
  } finally { rmSync(dir, { recursive: true, force: true }); }

  H("THE RUNNER: an agent stopped mid-report, the next boot asks again (E3, the R2 kill)");
  const company = (process.env.MKCP_PRACTICE_COMPANY ?? "").trim() || "ZZ PRACTICE CO";
  const guid = (process.env.MKCP_PRACTICE_COMPANY_GUID ?? "").trim() || "zz-test-guid-0001";
  const guidBefore = process.env.MKCP_PRACTICE_COMPANY_GUID;
  if (!guidBefore?.trim()) process.env.MKCP_PRACTICE_COMPANY_GUID = guid;
  const esc = (x: string) => x.replace(/&/g, "&amp;");
  const listing = `<ENVELOPE><BODY><DATA><COLLECTION><COMPANY NAME="${esc(company)}"><NAME>${esc(company)}</NAME><GUID>${guid}</GUID></COMPANY></COLLECTION></DATA></BODY></ENVELOPE>`;
  const tb = `<ENVELOPE><DSPACCNAME><DSPDISPNAME>ZZ TEST GROUP</DSPDISPNAME></DSPACCNAME><DSPACCINFO><DSPCLDRAMT><DSPCLDRAMTA>-100.00</DSPCLDRAMTA></DSPCLDRAMT><DSPCLCRAMT><DSPCLCRAMTA></DSPCLCRAMTA></DSPCLCRAMT></DSPACCINFO></ENVELOPE>`;
  const sent: string[] = [];
  installMock(async (_u, xml) => { sent.push(xml); return /List of Companies/i.test(xml) ? listing : tb; });
  try {
    /* Boot A took the job and stopped (killed) before writing anything: the row says running, started a minute ago. */
    const db = memDb({
      tally_report_jobs: [
        { id: "J-KILLED", company, report: "trial-balance", from_date: "2026-04-01", to_date: "2026-11-05", status: "running", started_at: ago(60_000), progress: "Asking Tally for Trial balance…", created_at: ago(70_000) },
        { id: "J-DONE", company, report: "trial-balance", status: "done", started_at: ago(3_600_000), created_at: ago(3_700_000) },
      ],
      tally_report_snapshots: [],
    });
    const resumes = memResumes();
    const b = new ReportRunner(db.client, "http://127.0.0.1:9", resumes, () => NOW, memClaims(["J-KILLED"]));
    await b.drain();
    const job = db.tables.tally_report_jobs.find((r) => r.id === "J-KILLED");
    const snap = db.tables.tally_report_snapshots.find((r) => r.job_id === "J-KILLED");
    ok("boot B puts the killed job back in the queue, counts the resume on disk, and runs it to done", job.status === "done" && resumes.count("J-KILLED") === 1, JSON.stringify({ status: job.status, error: job.error }));
    ok("the result is stored (the snapshot written before done), for the screen to read when it is opened again", !!snap && snap.row_count === 1 && snap.rows[0].name === "ZZ TEST GROUP");
    ok("while it ran again, its progress line said it was asked again", db.writes.some((w) => w.op === "update" && /Asked again: the office PC stopped/.test(w.patch?.progress ?? "")));
    ok("the put-back was compare-and-set on running and the first start", db.writes.some((w) => w.patch?.status === "pending" && w.filters.includes('"status","eq","running"') && w.filters.includes('"started_at","eq"')));
    ok("the finished job was not touched", db.tables.tally_report_jobs.find((r) => r.id === "J-DONE").status === "done" && !db.writes.some((w) => w.filters.includes("J-DONE")));
    ok("Tally was asked once for the report (after the GUID check)", sent.filter((x) => !/List of Companies/i.test(x)).length === 1);

    /* The same report brings boot B down too: boot C finds it running again, and it has had its one resume. */
    const db2 = memDb({ tally_report_jobs: [{ id: "J-LOOP", company, report: "trial-balance", status: "running", started_at: ago(30_000), created_at: ago(90_000) }], tally_report_snapshots: [] });
    const c = new ReportRunner(db2.client, "http://127.0.0.1:9", memResumes({ "J-LOOP": REPORT_RESUME_MAX }), () => NOW, memClaims(["J-LOOP"]));
    const before = sent.length;
    await c.drain();
    const j2 = db2.tables.tally_report_jobs[0];
    ok("a job that stopped the agent again is closed as an error with why, and Tally is not asked again", j2.status === "error" && /already been asked again/.test(j2.error) && !!j2.finished_at && sent.length === before);

    H("THE RUNNER: a result row never written (E6)");
    const db3 = memDb({ tally_report_jobs: [], tally_report_snapshots: [] });
    const d = new ReportRunner(db3.client, "http://127.0.0.1:9", memResumes(), () => NOW, memClaims());
    await d.drain();   // the boot sweep, nothing there
    db3.tables.tally_report_jobs.push({ id: "J-STUCK", company, report: "trial-balance", status: "running", started_at: ago(REPORT_STUCK_MS + 60_000), created_at: ago(REPORT_STUCK_MS + 90_000) });
    db3.tables.tally_report_jobs.push({ id: "J-YOUNG", company, report: "trial-balance", status: "running", started_at: ago(120_000), created_at: ago(130_000) });
    await d.drain();
    const st = db3.tables.tally_report_jobs.find((r) => r.id === "J-STUCK"), yg = db3.tables.tally_report_jobs.find((r) => r.id === "J-YOUNG");
    ok("after boot, a job running past the stuck time is closed as an error naming why", st.status === "error" && /No result was written within 20 minutes/.test(st.error) && st.progress === null);
    ok("a younger running job is left alone (it may still be running somewhere)", yg.status === "running");
    ok("an error is never a blank result: no snapshot was written for the stuck job", !db3.tables.tally_report_snapshots.some((r) => r.job_id === "J-STUCK"));

    H("REVIEW 1 (thread 7): a resume that cannot be recorded never stops the queue");
    const dbR = memDb({
      tally_report_jobs: [
        { id: "J-OWN", company, report: "trial-balance", status: "running", started_at: ago(60_000), created_at: ago(80_000) },
        { id: "J-NEXT", company, report: "trial-balance", status: "pending", created_at: ago(50_000) },
      ],
      tally_report_snapshots: [],
    });
    const brokenResumes = { count: () => 0, add: () => { throw new Error("EROFS: read-only file system"); } };
    const r1 = new ReportRunner(dbR.client, "http://127.0.0.1:9", brokenResumes, () => NOW, memClaims(["J-OWN"]));
    let threw = "";
    try { await r1.drain(); } catch (e) { threw = (e as Error).message; }
    const own = dbR.tables.tally_report_jobs.find((r) => r.id === "J-OWN"), nxt = dbR.tables.tally_report_jobs.find((r) => r.id === "J-NEXT");
    ok("the drain does not throw when the resume cannot be written", threw === "", threw);
    ok("that job is closed as an error that says why, not asked again", own.status === "error" && /could not record/.test(own.error) && !!own.finished_at, JSON.stringify(own));
    ok("the pending job behind it still runs to done", nxt.status === "done", nxt.status);
    const dbS = memDb({ tally_report_jobs: [{ id: "J-AFTER", company, report: "trial-balance", status: "pending", created_at: ago(50_000) }], tally_report_snapshots: [] });
    const failingSweep = { count: () => { throw new Error("disk gone"); }, add: () => {} };
    dbS.tables.tally_report_jobs.push({ id: "J-R", company, report: "trial-balance", status: "running", started_at: ago(1000), created_at: ago(90_000) });
    let t2 = "";
    try { await new ReportRunner(dbS.client, "http://127.0.0.1:9", failingSweep, () => NOW, memClaims(["J-R"])).drain(); } catch (e) { t2 = (e as Error).message; }
    ok("even a sweep that throws leaves the queue running", t2 === "" && dbS.tables.tally_report_jobs.find((r) => r.id === "J-AFTER").status === "done", t2);

    H("REVIEW 2 (thread 7): only this machine's own leftovers are asked again; running means on Tally");
    const dbM = memDb({
      tally_report_jobs: [
        { id: "J-OTHER", company, report: "trial-balance", status: "running", started_at: ago(120_000), created_at: ago(150_000) },
        { id: "J-OTHER-OLD", company, report: "trial-balance", status: "running", started_at: ago(REPORT_STUCK_MS + 60_000), created_at: ago(REPORT_STUCK_MS + 90_000) },
      ],
      tally_report_snapshots: [],
    });
    const sentBefore = sent.length;
    const m1 = new ReportRunner(dbM.client, "http://127.0.0.1:9", memResumes(), () => NOW, memClaims());
    await m1.drain();
    const o1 = dbM.tables.tally_report_jobs.find((r) => r.id === "J-OTHER"), o2 = dbM.tables.tally_report_jobs.find((r) => r.id === "J-OTHER-OLD");
    ok("a running job this machine never claimed is left alone at boot (it may be alive on another machine)", o1.status === "running" && sent.length === sentBefore);
    ok("a running job nobody here claimed that passed the stuck time is still closed", o2.status === "error" && /No result was written within 20 minutes/.test(o2.error));
    ok("the plan: at boot a job not claimed here is neither resumed nor failed while young",
      (() => { const pl = planOrphanReports(NOW, true, [{ id: "X", status: "running", started_at: ago(60_000) }], () => 0, null, () => false); return pl.resume.length === 0 && pl.fail.length === 0; })());
    const cdir = mkdtempSync(join(tmpdir(), "report-claims-"));
    try {
      const cl = reportClaimLog(join(cdir, "c.jsonl"));
      ok("the claim log: nothing yet, then a claim is remembered by a new process", !cl.has("J1") && (cl.add("J1"), reportClaimLog(join(cdir, "c.jsonl")).has("J1")) && !cl.has("J2"));
      writeFileSync(join(cdir, "bad.jsonl"), "{not json" + String.fromCharCode(10));
      ok("an unreadable claim log means not mine (left to the stuck rule, never requeued)", !reportClaimLog(join(cdir, "bad.jsonl")).has("J1"));
    } finally { rmSync(cdir, { recursive: true, force: true }); }

    /* "Running" means on Tally: the first write for a pending job is only a progress line (status untouched, guarded on pending);
       the claim to running is a separate compare-and-set made inside the Tally gate. */
    const dbG = memDb({ tally_report_jobs: [{ id: "J-WAIT", company, report: "trial-balance", status: "pending", created_at: ago(5000) }], tally_report_snapshots: [] });
    const claimsG = memClaims();
    await new ReportRunner(dbG.client, "http://127.0.0.1:9", memResumes(), () => NOW, claimsG).drain();
    const wj = dbG.writes.filter((w) => w.table === "tally_report_jobs" && w.op === "update");
    const first = wj[0], claimW = wj.find((w) => w.patch?.status === "running");
    ok("the first write for a waiting job is a progress line only: no status, no start, guarded on pending",
      !!first && first.patch.status === undefined && first.patch.started_at === undefined && /Asking Tally/.test(first.patch.progress ?? "") && first.filters.includes('"status","eq","pending"'), JSON.stringify(first));
    ok("the claim to running is a separate write, compare-and-set on pending, with the start time", !!claimW && claimW.filters.includes('"status","eq","pending"') && !!claimW.patch.started_at && wj.indexOf(claimW) > 0);
    const doneG = dbG.tables.tally_report_jobs[0];
    ok("it ran to done, and the claim is on this machine's log", doneG.status === "done" && claimsG.has("J-WAIT"), JSON.stringify(doneG));
    const dbT = memDb({ tally_report_jobs: [{ id: "J-TAKEN", company, report: "trial-balance", status: "pending", created_at: ago(5000) }], tally_report_snapshots: [] });
    const realFrom = dbT.client.from;
    dbT.client.from = (t: string) => { const b = realFrom(t); const upd = b.update; b.update = (p: any) => { if (p?.status === "running") dbT.tables.tally_report_jobs[0].status = "running"; return upd(p); }; return b; };   // another machine takes it just before this one's claim
    const before2 = sent.filter((x) => !/List of Companies/i.test(x)).length;
    await new ReportRunner(dbT.client, "http://127.0.0.1:9", memResumes(), () => NOW, memClaims()).drain();
    ok("a job another machine took first is not run here, and Tally is not asked", sent.filter((x) => !/List of Companies/i.test(x)).length === before2 && dbT.tables.tally_report_jobs[0].status === "running");
  } finally {
    uninstallMock();
    if (guidBefore === undefined) delete process.env.MKCP_PRACTICE_COMPANY_GUID; else process.env.MKCP_PRACTICE_COMPANY_GUID = guidBefore;
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
