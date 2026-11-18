/**
 * JOB: how often the office agent asks the database for work, and how it slows down when the database is struggling (lane agent-poll, 18-Nov-2026).
 * Pure: no database, no clock, no timers. `PrimaryQueueLoop` (primaryRunner.ts) uses these numbers; nothing else decides them.
 *
 * Why: on 18-Nov-2026 the live database stalled three times in two days, and the agent's own lease call was the single biggest group of
 * statements that timed out (146 in 24 hours). Every round makes three calls (take the lease, list this machine's open jobs, claim) about every 12 s,
 * and a lease is a write. The owner chose one round every 30 s, and a longer wait after every failure.
 *
 * Lease safety (the number that must not drift): the database keeps the queue lease for `p_seconds` after each heartbeat (clamped to 30..300 by
 * `erp_agent_take_lease`) and the agent only renews it at the start of a round (and every 30 s while a round is running). So the lease must outlast
 * the longest gap between two rounds of a healthy agent, at least three times over, or a second machine of the same role could take it between
 * polls and the two would flap. `leaseSecondsFor` gives that number; the agent passes it as the lease length. No database change is needed.
 */

/** One round every 30 s. The environment may change it (MKCP_PRIMARY_POLL_MS, read by readPrimaryConfig) but only inside the safe range below. */
export const JOB_POLL_MS = 30_000;
/** Each wait is stretched or shortened by up to this share, so two machines or two restarts never march in step. */
export const JOB_POLL_JITTER = 0.1;
/** After a failed round the wait doubles (30, 60, 120, 240 s) and never goes past this. A good round puts it back to the poll time. */
export const JOB_BACKOFF_MAX_MS = 300_000;
/** The longest a healthy round is expected to take (three database calls, a company-list read of Tally). Used only to size the lease. */
export const JOB_ROUND_BUDGET_MS = 10_000;
/** The lease must be at least this many times the longest healthy gap between two heartbeats. */
export const LEASE_SAFETY_FACTOR = 3;
/** What `erp_agent_take_lease` accepts (it clamps p_seconds to 30..300). */
export const DB_LEASE_MIN_SEC = 30;
export const DB_LEASE_MAX_SEC = 300;

/** Never faster than one round a second (the old floor). */
export const JOB_POLL_MIN_MS = 1_000;

/** The longest gap between two heartbeats of a healthy agent for a poll time: the poll plus its jitter plus the round itself. */
export function longestHealthyGapMs(pollMs: number): number {
  return Math.ceil(pollMs * (1 + JOB_POLL_JITTER)) + JOB_ROUND_BUDGET_MS;
}

/** The lease length to ask for, in seconds: three times the longest healthy gap, rounded up to 10 s, never below the old 90 s. */
export function leaseSecondsFor(pollMs: number): number {
  const need = Math.ceil((LEASE_SAFETY_FACTOR * longestHealthyGapMs(pollMs)) / 10_000) * 10;
  return Math.max(90, need);
}

/** The slowest poll whose lease still fits the database's 300 s ceiling. */
export const JOB_POLL_MAX_MS = (() => {
  let p = JOB_POLL_MIN_MS;
  while (leaseSecondsFor(p + 1_000) <= DB_LEASE_MAX_SEC) p += 1_000;
  return p;
})();

/** The poll time from the environment: a number of ms inside the safe range, else the default. Out of range is the default, never a silent clamp. */
export function jobPollMs(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= JOB_POLL_MIN_MS && n <= JOB_POLL_MAX_MS ? Math.round(n) : JOB_POLL_MS;
}

/** A wait with plus or minus 10 percent. `rand` is 0 to 1 (0.5 gives the wait unchanged). */
export function withJitter(ms: number, rand: () => number = Math.random): number {
  const r = Math.min(1, Math.max(0, rand()));
  return Math.round(ms * (1 - JOB_POLL_JITTER + 2 * JOB_POLL_JITTER * r));
}

/** The wait after the `fails`-th failed round in a row (1 = the first): the poll time, doubled each time, to the ceiling. */
export function backoffMs(pollMs: number, fails: number): number {
  if (fails <= 0) return pollMs;
  return Math.min(JOB_BACKOFF_MAX_MS, pollMs * 2 ** (fails - 1));
}
