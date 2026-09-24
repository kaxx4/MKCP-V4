/**
 * Runs the report jobs the web app asks for.
 *
 * ── The shape, and why it is a queue rather than an endpoint ──────────────
 *
 * A browser cannot reach Tally — the XML port is on the operator's machine —
 * and it could not wait anyway: the first call to Stock Summary in a Tally
 * session takes over a minute. So the web writes an intent to
 * `tally_report_jobs`, this picks it up, and the answer goes back through
 * `tally_report_snapshots`.
 *
 * ── One at a time, always ─────────────────────────────────────────────────
 *
 * Tally's port is single-threaded and every request here shares it with the
 * voucher pushes and the masters sync. Two at once is how a hang starts, so
 * jobs run strictly in sequence, behind the same `withTally` gate everything
 * else uses. A report is a READ, so it can never corrupt the books — the worst
 * it can do is make the office wait, and the gate is what stops that.
 *
 * ── Progress is written, not inferred ─────────────────────────────────────
 *
 * The `progress` column carries a sentence the operator can read, updated at
 * each real step. It is not a percentage: nothing here knows how far through
 * Tally is, and a bar that moves on a timer is a lie about work that has not
 * happened.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseClient, offlineReason } from "./supabaseClient.js";
import { withTally } from "./tallyGate.js";
import { fetchReport, reportByKey, REPORTS } from "./tallyReports.js";
import { resolveSyncCompany } from "./scheduledSyncs.js";

// ── The daily refresh ─────────────────────────────────────────────────────
//
// Owner, 24-Sep-2026: "each report you pull from Tally is data for seasonal
// demand, cash flow, margins, dead stock." A report that only refreshes when
// somebody presses a button is not data an algorithm can stand on: measured
// that day, every snapshot in `tally_report_snapshots` was one or two days old
// and `reorder-status` had never been fetched at all, because nothing but a
// click had ever asked. The web pages now read these snapshots as ground truth
// (web-dashboard/src/engine/tallyBooks.ts), so the agent asks for every report
// once a day on its own, through the same queue a click uses.
//
// Once per report per day, never more: a report is due when its snapshot was
// captured before today's hour AND no daily job for it has been created since
// then. The second half is what stops a closed Tally from turning into a job a
// minute all evening — a failed attempt is a job row, so it counts as "asked".

/** `requested_by` on a job this agent queued for itself. */
export const DAILY_REQUESTER = "agent-daily";

/** Local hour after which the day's refresh is due. Evening, beside the 18:00
 *  price/GST pull: the office has finished typing the day's vouchers. */
export function dailyReportHour(): number {
  const h = parseInt(process.env.REPORTS_DAILY_HOUR ?? "18", 10);
  return Number.isFinite(h) ? Math.min(23, Math.max(0, h)) : 18;
}

/**
 * Which reports to queue now. Pure: every input is a value, so the schedule is
 * testable without a clock, Tally or Supabase (scripts/test-report-schedule.ts).
 *
 * @param snapshots  the company's latest snapshot per report
 * @param jobs       the company's recent jobs (any status)
 */
export function reportsDueForDailyRefresh(
  now: Date,
  hour: number,
  keys: readonly string[],
  snapshots: readonly { report: string; captured_at: string | null }[],
  jobs: readonly { report: string; status: string; created_at: string; requested_by?: string | null }[],
): string[] {
  if (now.getHours() < hour) return [];
  const threshold = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, 0, 0).getTime();
  const capturedAt = new Map(snapshots.map((s) => [s.report, s.captured_at ? Date.parse(s.captured_at) : NaN]));
  return keys.filter((key) => {
    const t = capturedAt.get(key);
    if (t !== undefined && Number.isFinite(t) && t >= threshold) return false; // already fresh today
    return !jobs.some((j) =>
      j.report === key &&
      (j.status === "pending" || j.status === "running" ||
        (j.requested_by === DAILY_REQUESTER && Date.parse(j.created_at) >= threshold)));
  });
}

export interface ReportJob {
  id: string;
  company: string;
  report: string;
  from_date: string | null;
  to_date: string | null;
  status: string;
}

/** Financial year to date, which is what every one of these reports means by
 *  "now" unless the caller says otherwise. */
function defaultPeriod(): { from: string; to: string } {
  const now = new Date();
  const y = now.getMonth() + 1 >= 4 ? now.getFullYear() : now.getFullYear() - 1;
  return { from: `${y}-04-01`, to: now.toISOString().slice(0, 10) };
}

export class ReportRunner {
  private busy = false;
  private stopped = false;

  constructor(
    private readonly client: SupabaseClient,
    private readonly tallyUrl: string,
  ) {}

  /** Claim and run everything pending, oldest first. Safe to call often. */
  async drain(): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      for (;;) {
        const { data, error } = await this.client
          .from("tally_report_jobs")
          .select("id, company, report, from_date, to_date, status")
          .eq("status", "pending")
          .order("created_at", { ascending: true })
          .limit(1);
        if (error) { console.error(`[reports] could not read the queue: ${error.message}`); return; }
        const job = (data ?? [])[0] as ReportJob | undefined;
        if (!job) return;
        await this.run(job);
      }
    } finally {
      this.busy = false;
    }
  }

  private async note(id: string, progress: string): Promise<void> {
    await this.client.from("tally_report_jobs").update({ progress }).eq("id", id);
  }

  private async run(job: ReportJob): Promise<void> {
    const def = reportByKey(job.report);
    if (!def) {
      /* An unknown key is a bug in the caller, not a Tally problem, and it must
         not be retried for ever. Named plainly so whoever reads the queue can
         see which key was asked for and what the real ones are. */
      await this.client.from("tally_report_jobs").update({
        status: "error",
        error: `No report called "${job.report}". Known: ${REPORTS.map((r) => r.key).join(", ")}`,
        finished_at: new Date().toISOString(),
      }).eq("id", job.id);
      return;
    }

    const period = job.from_date && job.to_date
      ? { from: job.from_date, to: job.to_date }
      : defaultPeriod();

    await this.client.from("tally_report_jobs").update({
      status: "running",
      started_at: new Date().toISOString(),
      progress: def.slow
        ? `Asking Tally for ${def.label}. This one takes about a minute the first time.`
        : `Asking Tally for ${def.label}…`,
    }).eq("id", job.id);

    try {
      const result = await withTally(this.tallyUrl, `report ${def.key}`,
        () => fetchReport(this.tallyUrl, job.company, def, period));

      await this.note(job.id, `Storing ${result.rows.length} rows…`);

      /* The snapshot is written BEFORE the job is marked done. A page watching
         for `done` and then reading the snapshot must never find the old one —
         that race would show yesterday's figures under today's timestamp, which
         is worse than showing nothing. */
      const { error: snapErr } = await this.client.from("tally_report_snapshots").upsert({
        company: job.company,
        report: def.key,
        job_id: job.id,
        from_date: def.period ? period.from : null,
        to_date: def.period ? period.to : null,
        rows: result.rows,
        row_count: result.rows.length,
        elapsed_ms: result.elapsedMs,
        captured_at: new Date().toISOString(),
      }, { onConflict: "company,report" });
      if (snapErr) throw new Error(`stored nothing: ${snapErr.message}`);

      await this.client.from("tally_report_jobs").update({
        status: "done",
        progress: null,
        row_count: result.rows.length,
        bytes: result.bytes,
        elapsed_ms: result.elapsedMs,
        finished_at: new Date().toISOString(),
      }).eq("id", job.id);

      console.log(`[reports] ✓ ${def.key}: ${result.rows.length} rows in ${result.elapsedMs}ms`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      /* A failed run leaves the previous snapshot standing. A refresh that
         fails should not blank a screen that was showing good figures a
         moment ago. */
      await this.client.from("tally_report_jobs").update({
        status: "error",
        progress: null,
        error: msg,
        finished_at: new Date().toISOString(),
      }).eq("id", job.id);
      console.error(`[reports] ✗ ${def.key}: ${msg}`);
    }
  }

  /**
   * Watch for new jobs, and sweep on a timer as a backstop.
   *
   * Realtime alone is not enough: a job inserted while the agent was asleep or
   * between reconnects arrives as no event at all, and would sit pending for
   * ever with the operator watching a chip that never moves. The timer is what
   * makes "it will get there" true.
   */
  start(pollMs = 20_000): () => void {
    const channel = this.client
      .channel("report-jobs")
      .on("postgres_changes",
        { event: "INSERT", schema: "public", table: "tally_report_jobs" },
        () => { void this.drain(); })
      .subscribe();

    const timer = setInterval(() => { void this.drain(); }, pollMs);
    void this.drain();

    /* The daily refresh checks once a minute, like the other schedules, so a
       machine asleep at the hour catches up the moment it wakes. */
    const daily = (process.env.REPORTS_DAILY_ENABLED ?? "true").toLowerCase() !== "false";
    const dailyTimer = daily ? setInterval(() => { void this.queueDaily(); }, 60_000) : null;
    if (daily) void this.queueDaily();
    else console.log("📊 [REPORTS] daily refresh OFF (REPORTS_DAILY_ENABLED=false)");

    return () => {
      this.stopped = true;
      clearInterval(timer);
      if (dailyTimer) clearInterval(dailyTimer);
      void this.client.removeChannel(channel);
    };
  }

  /** Queue today's refresh for every report that is due. See the note at the
   *  top of this file. Errors are logged and the next minute tries again. */
  private async queueDaily(): Promise<void> {
    if (this.stopped) return;
    const now = new Date();
    const hour = dailyReportHour();
    if (now.getHours() < hour) return;
    try {
      const company = await resolveSyncCompany("");
      if (!company) return;
      const since = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour).toISOString();
      const [snaps, jobs] = await Promise.all([
        this.client.from("tally_report_snapshots").select("report, captured_at").eq("company", company),
        this.client.from("tally_report_jobs")
          .select("report, status, created_at, requested_by")
          .eq("company", company)
          .or(`status.in.(pending,running),created_at.gte.${since}`),
      ]);
      if (snaps.error) throw new Error(snaps.error.message);
      if (jobs.error) throw new Error(jobs.error.message);
      const due = reportsDueForDailyRefresh(now, hour, REPORTS.map((r) => r.key), snaps.data ?? [], jobs.data ?? []);
      if (!due.length) return;
      const { error } = await this.client.from("tally_report_jobs").insert(
        /* Born DISMISSED. The web's report dock lists every undismissed job,
           and fifteen notices every evening for a refresh nobody asked for
           would train the office to ignore the dock. The pages that read these
           snapshots state each figure's capture time, which is where a failed
           refresh shows: as an old date, not as a toast. */
        due.map((report) => ({ company, report, requested_by: DAILY_REQUESTER, dismissed_at: new Date().toISOString() })),
      );
      if (error) throw new Error(error.message);
      console.log(`📊 [REPORTS] daily refresh queued: ${due.join(", ")}`);
      void this.drain();
    } catch (e) {
      console.error(`📊 [REPORTS] daily refresh could not queue: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/**
 * Start the runner, or say plainly why it cannot.
 *
 * Mirrors `startPushListener`: without a service key it logs and returns rather
 * than crashing the proxy. A missing key must not take Tally offline for the
 * whole office because a report cannot be fetched.
 */
export function startReportRunner(tally: string): () => void {
  /* THROUGH THE CHOKEPOINT, like the other eight services.
     This was the one module still calling `createClient` directly, so the
     sandbox short-circuit in supabaseClient.ts — which is what actually keeps a
     copy of the company off the shared mirror — did not apply to it. It reads
     from Tally but WRITES `tally_report_snapshots`, a shared table keyed on a
     company name the copy shares with the real books: a report someone asked
     for on the web would have been answered from the SANDBOX and stored as the
     company's own figures, with nothing on screen saying which machine
     answered. "Read-only against Tally" is not "safe to run from a copy".

     `scripts/test-offline-mode.ts` asserts this exact property and had been
     FAILING on this file — a red test nobody was running. Fixed by joining the
     chokepoint rather than by adding a ninth hand-written guard, which is the
     argument supabaseClient.ts makes in its own header. */
  const client = supabaseClient();
  if (!client) {
    /* Say which, and say it here. `supabaseClient()` logs the offline reason
       once for the whole process, and the other six services each announce
       their own refusal by name — a service that simply never starts is
       indistinguishable from one that started and is doing nothing, which is
       the failure mode this repo keeps producing. */
    console.log(`📊 [REPORTS] on-demand reports OFF — ${offlineReason() ?? "SUPABASE_SERVICE_KEY is not set"}`);
    return () => {};
  }
  const runner = new ReportRunner(client, tally);
  console.log("📊 [REPORTS] on-demand report runner listening");
  return runner.start();
}
