-- Migration 034: the approval spine and recurring definitions.
--
-- APPLIED 14-Sep-2026 as Supabase migration `approval_spine_and_recurring`.
--
-- The decision this encodes: NOTHING UNATTENDED WRITES TO TALLY. Automation
-- prepares; a person approves; the approved thing goes through the same
-- safePush, guard and read-back diff as anything typed by hand. A direct
-- operator action stays immediate — a person acting is not a rule firing — so
-- these tables are only for what the SYSTEM proposed.
--
-- Every proposal must answer four questions or approving it is rubber-stamping:
-- what it would post (the actual VoucherPayloads, not a description), why, what
-- it derived from, and how sure it is. confidence may be NULL — that is honest;
-- a fabricated 0.9 is not.
--
-- Anyone may approve. No hierarchy, no value thresholds: what makes that safe is
-- that every decision is attributed and every pre-approval edit is flagged.
-- Thresholds would only mean the person who is there cannot clear the queue.
--
-- Nothing expires. A recurring rent entry nobody approved is a problem to shout
-- about, not to silently drop, so the indexes make an ageing view cheap.
--
-- Scheduled release needed NO new column: push_queue.not_before already exists
-- and is exactly that. (A comment in the web app claiming otherwise had rotted.)

CREATE TABLE IF NOT EXISTS mkcp_proposals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company       text NOT NULL,
  kind          text NOT NULL,
  title         text NOT NULL,
  payload       jsonb NOT NULL,
  rationale     text,
  derived_from  jsonb,
  confidence    numeric,
  state         text NOT NULL DEFAULT 'pending'
                CHECK (state IN ('pending','approved','rejected','superseded','failed')),
  decided_by    text,
  decided_at    timestamptz,
  was_edited    boolean NOT NULL DEFAULT false,
  decision_note text,
  batch_id      uuid,
  not_before    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mkcp_proposals_pending
  ON mkcp_proposals (company, created_at) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS idx_mkcp_proposals_kind
  ON mkcp_proposals (company, kind, state);

CREATE TABLE IF NOT EXISTS mkcp_recurring (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company       text NOT NULL,
  name          text NOT NULL,
  enabled       boolean NOT NULL DEFAULT true,
  cadence       text NOT NULL CHECK (cadence IN ('monthly','weekly')),
  day_of_month  integer CHECK (day_of_month BETWEEN 1 AND 31),
  day_of_week   integer CHECK (day_of_week BETWEEN 0 AND 6),
  lead_days     integer NOT NULL DEFAULT 2,
  template      jsonb NOT NULL,
  last_proposed_for date,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mkcp_recurring_enabled
  ON mkcp_recurring (company, enabled) WHERE enabled;

-- One definition proposes once per period. Without this a restart, a double
-- mount or two overlapping runs books the rent twice, and the second one looks
-- exactly as legitimate as the first. In the DATABASE because an in-memory
-- check cannot see another tab.
CREATE UNIQUE INDEX IF NOT EXISTS uq_mkcp_recurring_period
  ON mkcp_proposals (company, kind, (payload ->> 'recurringId'), (payload ->> 'period'))
  WHERE kind = 'recurring';

ALTER TABLE mkcp_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE mkcp_recurring ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mkcp_proposals_rw ON mkcp_proposals;
CREATE POLICY mkcp_proposals_rw ON mkcp_proposals FOR ALL USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS mkcp_recurring_rw ON mkcp_recurring;
CREATE POLICY mkcp_recurring_rw ON mkcp_recurring FOR ALL USING (true) WITH CHECK (true);

ALTER PUBLICATION supabase_realtime ADD TABLE mkcp_proposals;
