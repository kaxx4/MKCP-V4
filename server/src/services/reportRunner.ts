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
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { withTally } from "./tallyGate.js";
import { fetchReport, reportByKey, REPORTS } from "./tallyReports.js";

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

    return () => {
      this.stopped = true;
      clearInterval(timer);
      void this.client.removeChannel(channel);
    };
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
  const url = process.env.SUPABASE_URL || "https://vmkytsytxlofjyeotmgb.supabase.co";
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!key) {
    console.error("📊 [REPORTS] SUPABASE_SERVICE_KEY not set — on-demand Tally reports disabled.");
    return () => {};
  }
  const client = createClient(url, key, { auth: { persistSession: false } });
  const runner = new ReportRunner(client, tally);
  console.log("📊 [REPORTS] on-demand report runner listening");
  return runner.start();
}
