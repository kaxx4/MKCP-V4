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
import { ReportRunner, planOrphanReports, reportResumeLog, REPORT_RESUME_MAX, REPORT_STUCK_MS, type RunningReportJob } from "../src/services/reportRunner.js";
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
    const b = new ReportRunner(db.client, "http://127.0.0.1:9", resumes, () => NOW);
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
    const c = new ReportRunner(db2.client, "http://127.0.0.1:9", memResumes({ "J-LOOP": REPORT_RESUME_MAX }), () => NOW);
    const before = sent.length;
    await c.drain();
    const j2 = db2.tables.tally_report_jobs[0];
    ok("a job that stopped the agent again is closed as an error with why, and Tally is not asked again", j2.status === "error" && /already been asked again/.test(j2.error) && !!j2.finished_at && sent.length === before);

    H("THE RUNNER: a result row never written (E6)");
    const db3 = memDb({ tally_report_jobs: [], tally_report_snapshots: [] });
    const d = new ReportRunner(db3.client, "http://127.0.0.1:9", memResumes(), () => NOW);
    await d.drain();   // the boot sweep, nothing there
    db3.tables.tally_report_jobs.push({ id: "J-STUCK", company, report: "trial-balance", status: "running", started_at: ago(REPORT_STUCK_MS + 60_000), created_at: ago(REPORT_STUCK_MS + 90_000) });
    db3.tables.tally_report_jobs.push({ id: "J-YOUNG", company, report: "trial-balance", status: "running", started_at: ago(120_000), created_at: ago(130_000) });
    await d.drain();
    const st = db3.tables.tally_report_jobs.find((r) => r.id === "J-STUCK"), yg = db3.tables.tally_report_jobs.find((r) => r.id === "J-YOUNG");
    ok("after boot, a job running past the stuck time is closed as an error naming why", st.status === "error" && /No result was written within 20 minutes/.test(st.error) && st.progress === null);
    ok("a younger running job is left alone (it may still be running somewhere)", yg.status === "running");
    ok("an error is never a blank result: no snapshot was written for the stuck job", !db3.tables.tally_report_snapshots.some((r) => r.job_id === "J-STUCK"));
  } finally {
    uninstallMock();
    if (guidBefore === undefined) delete process.env.MKCP_PRACTICE_COMPANY_GUID; else process.env.MKCP_PRACTICE_COMPANY_GUID = guidBefore;
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
