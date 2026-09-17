-- Migration 041: on-demand Tally reports, as tracked jobs.
--
-- NOT YET APPLIED. Run it, then confirm the OBJECTS exist rather than trusting
-- this file — `CREATE TABLE IF NOT EXISTS` is a no-op, not an upgrade, and that
-- is exactly how `push_queue` sat dead for months (P5).
--
-- ── Why a job and not a fetch ─────────────────────────────────────────────
--
-- Tally's XML port is single-threaded and a report holds it for as long as it
-- runs. Measured on the live books, 17-Sep-2026: Bills Payable, Ratio Analysis,
-- Trial Balance and the rest answer in well under a second, but Stock Summary,
-- Godown Summary, Movement Analysis and Reorder Status each take OVER SIXTY
-- SECONDS on their first call in a Tally session. (They are fast afterwards —
-- Tally caches a computed report until the session ends — so a naive test run
-- twice reports them as quick and they are not.)
--
-- A page cannot wait a minute, and a browser cannot reach Tally at all: the
-- port is on the operator's machine. So the web writes an intent here, the
-- desktop agent picks it up over Realtime, runs it, and writes the answer back.
-- The operator watches progress from any page and is told when it lands.
--
-- ── Two tables, deliberately ──────────────────────────────────────────────
--
-- `tally_report_jobs`      one row per RUN. The history, including failures.
-- `tally_report_snapshots` one row per (company, report). The LATEST good run,
--                          which is what every page reads.
--
-- Splitting them means a page never has to ask "which job was the most recent
-- successful one" — a question with a wrong answer available whenever a run is
-- in flight. A failed run leaves the last good snapshot standing, which is the
-- behaviour anyone would want: a refresh that fails should not blank the screen.

-- ════════════════════════════════════════════════════════════════════
-- tally_report_jobs — the request, its progress, and its outcome
-- ════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS tally_report_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company TEXT NOT NULL,
  -- The catalogue key (`bills-payable`), never Tally's display name. The
  -- display name is the agent's business; a key that changed with a label
  -- would orphan every stored snapshot.
  report TEXT NOT NULL,
  -- ISO dates. Balance-type reports ignore them; stored anyway so a snapshot
  -- can always say what period it describes.
  from_date DATE,
  to_date DATE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','done','error','cancelled')),
  -- Plain English, shown in the progress chip: "asking Tally…", "parsing 94 rows".
  progress TEXT,
  requested_by TEXT NOT NULL DEFAULT 'web',
  row_count INTEGER,
  bytes INTEGER,
  elapsed_ms INTEGER,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  -- The operator has seen the "it's ready" notice. Nulled = still to show.
  -- Kept on the JOB rather than in browser storage on purpose: the person who
  -- asked for it may finish on a different device from the one they started on.
  dismissed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_report_jobs_open
  ON tally_report_jobs (company, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_report_jobs_report
  ON tally_report_jobs (company, report, created_at DESC);

ALTER TABLE tally_report_jobs ENABLE ROW LEVEL SECURITY;

-- The browser INSERTS a request and UPDATES only `dismissed_at`; the agent
-- holds the service role and does the rest. Kept as one permissive policy
-- because the table carries no money and no identity — it is a work ticket.
DROP POLICY IF EXISTS "report_jobs_service" ON public.tally_report_jobs;
CREATE POLICY "report_jobs_service" ON public.tally_report_jobs
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS "report_jobs_read" ON public.tally_report_jobs;
CREATE POLICY "report_jobs_read" ON public.tally_report_jobs
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "report_jobs_request" ON public.tally_report_jobs;
CREATE POLICY "report_jobs_request" ON public.tally_report_jobs
  FOR INSERT TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "report_jobs_dismiss" ON public.tally_report_jobs;
CREATE POLICY "report_jobs_dismiss" ON public.tally_report_jobs
  FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);

-- ════════════════════════════════════════════════════════════════════
-- tally_report_snapshots — the latest good run of each report
-- ════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS tally_report_snapshots (
  company TEXT NOT NULL,
  report TEXT NOT NULL,
  job_id UUID REFERENCES tally_report_jobs(id) ON DELETE SET NULL,
  from_date DATE,
  to_date DATE,
  -- The parsed rows, as an array of objects. One jsonb column rather than a
  -- table per report: fifteen reports have fifteen shapes and none of them is
  -- queried by column — every consumer wants the whole set at once.
  -- The largest here is Reorder Status at 489 rows / 142 KB, comfortably
  -- inside jsonb. "List of Accounts" is NOT one of these reports: it is 10.8 MB
  -- and it duplicates the masters sync.
  rows JSONB NOT NULL,
  row_count INTEGER NOT NULL,
  elapsed_ms INTEGER,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company, report)
);

ALTER TABLE tally_report_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "report_snapshots_service" ON public.tally_report_snapshots;
CREATE POLICY "report_snapshots_service" ON public.tally_report_snapshots
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- Without an explicit SELECT policy every browser read returns zero rows with
-- no error — the failure that made the discount tables look "broken" for
-- months (migration 023).
DROP POLICY IF EXISTS "report_snapshots_read" ON public.tally_report_snapshots;
CREATE POLICY "report_snapshots_read" ON public.tally_report_snapshots
  FOR SELECT TO anon, authenticated USING (true);

-- The progress chip and the "it's ready" notice both depend on Realtime
-- carrying job rows. Without this the UI works only by polling, which is the
-- thing it exists to avoid.
ALTER PUBLICATION supabase_realtime ADD TABLE tally_report_jobs;

NOTIFY pgrst, 'reload schema';
