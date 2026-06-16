// pushAgent.ts — Push-Queue Drain Agent (queue consumer)
//
// Runs inside the existing Electron-embedded server process. Drains the Supabase
// `push_queue` (Prompt 2 schema, migration 011) into Tally by REUSING the existing,
// frozen `pushVoucherToTally` — the hard voucher-XML problem is already solved there.
//
// Safety invariants:
//  - Sequential push per company. Tally is single-threaded per company; parallel pushes
//    corrupt voucher numbering. Jobs are processed one at a time (never Promise.all).
//  - Atomic claims via claim_push_jobs() + FOR UPDATE SKIP LOCKED → restarted/concurrent
//    agents never grab the same row.
//  - Idempotent: unique(idempotency_key) + a pre-push mirror check + periodic reconciliation
//    mean a crash AFTER Tally created the voucher but BEFORE we wrote success never
//    produces a duplicate invoice (the worst failure in the system).
//
// Connects with the service-role key (server-side only — never bundled into any renderer)
// so RLS does not block claims.

import os from "os";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { tallyPost, HEALTH_XML } from "../tally.js";
import { pushVoucherToTally } from "./voucherPusher.js";
import { isTallyBusy } from "./tallyBusy.js";
import type { VoucherPayload, PushResult } from "../types.js";

// ── Config ──────────────────────────────────────────────────────────────────────
const POLL_MS = 4000;          // fallback/heartbeat tick
const BATCH = 20;              // max rows claimed per tick
const LEASE_SEC = 120;         // claim lease; watchdog reclaims rows past this
const WATCHDOG_MS = 30_000;    // lease watchdog interval
const RECONCILE_MS = 120_000;  // post-push reconciliation interval

/** Exponential backoff with a 5-minute ceiling. attempt is the (incremented) attempt count. */
function backoffMs(attempt: number): number {
  return Math.min(Math.pow(2, attempt) * 5000, 5 * 60 * 1000);
}

const AGENT_ID = `${os.hostname()}#${process.pid}`;
const nowIso = () => new Date().toISOString();

// A push_queue row (mirrors migration 011 columns).
interface PushJob {
  id: string;
  company: string;
  payload: VoucherPayload;
  idempotency_key: string;
  priority: number;
  status: string;
  attempts: number;
  max_attempts: number;
}

// ── Runtime state (exposed via GET /api/push-agent/status) ───────────────────────
interface ResultLogEntry { id: string; idempotency_key: string; status: string; error?: string; at: string; }
const state = {
  enabled: false,
  started: false,
  lastTick: null as string | null,
  tallyHealthy: false,
  claimedCount: 0,
  last10Results: [] as ResultLogEntry[],
  queueStats: { pending: 0, pushing: 0, failed: 0 } as Record<string, number>,
};

function record(id: string, idempotency_key: string, status: string, error?: string) {
  state.last10Results.unshift({ id, idempotency_key, status, error, at: nowIso() });
  if (state.last10Results.length > 10) state.last10Results.length = 10;
}

let client: SupabaseClient | null = null;
let tallyUrl = "http://localhost:9000";
let tickRunning = false;
let timers: NodeJS.Timeout[] = [];
// When the queue is idle we still refresh the Tally-health indicator, but only
// every Nth tick (not every tick) so we don't ping Tally every 4s and collide
// with active pull-syncs (which would time out and spam errors).
let ticksSinceHealth = 0;
const HEALTH_REFRESH_TICKS = 8; // ~32s at POLL_MS=4000 when idle

/** Expose the service-role Supabase client for use in server routes (e.g. /requeue). */
export function getAgentClient() { return client; }

// ── Tally health (reuses the frozen tally.ts health envelope) ────────────────────
async function isTallyHealthy(): Promise<boolean> {
  // A pull-sync in flight already proves Tally is up — don't add a competing ping.
  if (isTallyBusy()) return true;
  try {
    await tallyPost(tallyUrl, HEALTH_XML, 3_000);
    return true;
  } catch {
    return false;
  }
}

/** Refresh live queue depth counters from Supabase (called at end of each tick). */
async function refreshQueueStats(): Promise<void> {
  if (!client) return;
  const { data } = await client
    .from("push_queue")
    .select("status")
    .in("status", ["pending", "pushing", "failed"]);
  const counts: Record<string, number> = { pending: 0, pushing: 0, failed: 0 };
  for (const row of (data ?? [])) counts[row.status] = (counts[row.status] ?? 0) + 1;
  state.queueStats = counts;
}

/** Write a permanent push resolution record to push_sync_log (succeeds or final-fail only). */
async function writePushLog(job: PushJob, status: "succeeded" | "failed", result: PushResult | null, resolvedAt: string): Promise<void> {
  if (!client) return;
  try {
    const payload = job.payload as VoucherPayload;
    await client.from("push_sync_log").insert({
      push_queue_id: job.id,
      company: job.company,
      idempotency_key: job.idempotency_key,
      voucher_type: payload.voucherType ?? null,
      party: payload.partyLedgerName ?? null,
      date: payload.date ?? null,
      status,
      tally_vch_id: result?.lastVoucherId ?? null,
      attempts: job.attempts,
      last_error: result?.lineErrors?.[0] ?? null,
      line_errors: result?.lineErrors?.length ? result.lineErrors : null,
      resolved_at: resolvedAt,
    });
  } catch (e: any) {
    console.warn(`[pushAgent] push_sync_log write failed: ${e.message}`);
    // Non-fatal — push_queue row is the source of truth.
  }
}

/** Look up an already-created voucher in the pulled-voucher mirror by reference. */
async function findInMirror(idempotencyKey: string): Promise<{ guid: string } | null> {
  if (!client) return null;
  const { data, error } = await client
    .from("tally_vouchers")
    .select("guid")
    .eq("reference", idempotencyKey)
    .limit(1);
  if (error || !data || data.length === 0) return null;
  return { guid: data[0].guid as string };
}

// ── Main tick ─────────────────────────────────────────────────────────────────--
async function tick(): Promise<void> {
  if (tickRunning || !client) return;
  tickRunning = true;
  try {
    state.lastTick = nowIso();

    // Claim FIRST (cheap Supabase call). No point pinging Tally — and colliding
    // with an in-progress pull-sync — when there's nothing to push.
    const { data: jobs, error } = await client.rpc("claim_push_jobs", {
      p_agent: AGENT_ID,
      p_limit: BATCH,
      p_lease_seconds: LEASE_SEC,
    });
    if (error) {
      console.error(`[pushAgent] claim failed: ${error.message}`);
      return;
    }

    const claimed = (jobs ?? []) as PushJob[];
    state.claimedCount = claimed.length;

    if (claimed.length === 0) {
      // Idle: refresh the Tally-health indicator only occasionally, not every tick.
      if (++ticksSinceHealth >= HEALTH_REFRESH_TICKS) {
        ticksSinceHealth = 0;
        state.tallyHealthy = await isTallyHealthy();
      }
      await refreshQueueStats();
      return;
    }

    // We have work — but if a pull-sync is hammering Tally's single-threaded
    // port, defer: release the claim and retry next tick once the sync is done.
    if (isTallyBusy()) {
      await releaseClaims(claimed);
      return;
    }

    // Verify Tally is up before pushing.
    ticksSinceHealth = 0;
    const healthy = await isTallyHealthy();
    state.tallyHealthy = healthy;
    if (!healthy) {
      // Tally down: release the claim immediately so the next tick retries
      // (instead of holding the lease for LEASE_SEC).
      await releaseClaims(claimed);
      return;
    }

    // SEQUENTIAL — never parallel to one company (Tally is single-threaded per company).
    for (const job of claimed) {
      await processJob(job);
    }
    await refreshQueueStats();
  } finally {
    tickRunning = false;
  }
}

/** Return claimed-but-unprocessed rows to `pending` so they retry on the next tick. */
async function releaseClaims(jobs: PushJob[]): Promise<void> {
  if (!client || jobs.length === 0) return;
  try {
    await client.from("push_queue")
      .update({ status: "pending", claimed_by: null, claimed_at: null, lease_until: null })
      .in("id", jobs.map((j) => j.id));
  } catch (e: any) {
    console.warn(`[pushAgent] releaseClaims failed (watchdog will reclaim): ${e?.message || e}`);
  }
}

async function processJob(job: PushJob): Promise<void> {
  if (!client) return;
  const newAttempts = job.attempts + 1;

  // Idempotency guard for retried jobs: if Tally already created this voucher on a prior
  // attempt (and the pull sync has mirrored it), succeed WITHOUT re-pushing. This closes
  // the lease-watchdog re-queue race. NOTE: bounded by pull-sync freshness — a voucher
  // created since the last pull may not yet be in the mirror (see reconcile + docs).
  if (job.attempts > 0) {
    const existing = await findInMirror(job.idempotency_key);
    if (existing) {
      await client.from("push_queue").update({
        status: "succeeded",
        tally_vch_id: existing.guid,
        last_error: "reconciled from mirror (pre-push)",
        pushed_at: nowIso(),
      }).eq("id", job.id);
      record(job.id, job.idempotency_key, "succeeded");
      return;
    }
  }

  await client.from("push_queue").update({ status: "pushing", attempts: newAttempts }).eq("id", job.id);

  try {
    const result: PushResult = await pushVoucherToTally(tallyUrl, job.company, job.payload);
    if (result.success) {
      const resolvedAt = nowIso();
      await client.from("push_queue").update({
        status: "succeeded",
        tally_vch_id: result.lastVoucherId,
        result: result as unknown as Record<string, unknown>,
        pushed_at: resolvedAt,
      }).eq("id", job.id);
      await writePushLog(job, "succeeded", result, resolvedAt);
      record(job.id, job.idempotency_key, "succeeded");
    } else {
      await fail(job, newAttempts, result.lineErrors?.join("; ") || "push failed", result);
    }
  } catch (e: any) {
    await fail(job, newAttempts, e?.message ?? String(e), null);
  }
}

async function fail(job: PushJob, newAttempts: number, msg: string, result: PushResult | null): Promise<void> {
  if (!client) return;
  if (newAttempts >= job.max_attempts) {
    const resolvedAt = nowIso();
    await client.from("push_queue").update({
      status: "failed",
      last_error: msg,
      result: (result as unknown as Record<string, unknown>) ?? null,
    }).eq("id", job.id);
    const syntheticResult = { ...(result ?? {}), lineErrors: msg ? [msg] : [] } as PushResult;
    await writePushLog(job, "failed", syntheticResult, resolvedAt);
    record(job.id, job.idempotency_key, "failed", msg);
  } else {
    await client.from("push_queue").update({
      status: "pending",
      last_error: msg,
      result: (result as unknown as Record<string, unknown>) ?? null,
      not_before: new Date(Date.now() + backoffMs(newAttempts)).toISOString(),
    }).eq("id", job.id);
    record(job.id, job.idempotency_key, "retry", msg);
  }
}

// ── Lease watchdog — recover rows orphaned by an agent crash ──────────────────────
async function leaseWatchdog(): Promise<void> {
  if (!client) return;
  const { error } = await client
    .from("push_queue")
    .update({ status: "pending", claimed_by: null, claimed_at: null, lease_until: null })
    .in("status", ["claimed", "pushing"])
    .lt("lease_until", nowIso());
  if (error) console.error(`[pushAgent] leaseWatchdog: ${error.message}`);
}

// ── Reconciliation — the subtle anti-duplicate backstop ───────────────────────────
// Covers the window the lease cannot: Tally created the voucher, but the agent crashed
// before writing `succeeded`. We stamped payload.reference = idempotency_key, and the
// pull sync mirrors it into tally_vouchers.reference (migration 012). If a candidate
// row's key is already in the mirror, mark it succeeded WITHOUT re-pushing.
async function reconcile(): Promise<void> {
  if (!client) return;
  const { data, error } = await client
    .from("push_queue")
    .select("id, idempotency_key, company")
    .in("status", ["pending", "pushing", "failed"])
    .gt("attempts", 0)
    .limit(200);
  if (error || !data) {
    if (error) console.error(`[pushAgent] reconcile: ${error.message}`);
    return;
  }
  if (data.length === 0) return;

  // Bulk lookup — one query instead of N sequential findInMirror calls.
  const keys = (data as Array<{ id: string; idempotency_key: string }>).map((r) => r.idempotency_key);
  const { data: mirrors } = await client
    .from("tally_vouchers")
    .select("guid, reference")
    .in("reference", keys);

  const mirrorMap = new Map<string, string>(); // idempotency_key → guid
  for (const m of (mirrors ?? []) as Array<{ guid: string; reference: string }>) {
    if (m.reference) mirrorMap.set(m.reference, m.guid);
  }

  for (const cand of data as Array<{ id: string; idempotency_key: string }>) {
    const guid = mirrorMap.get(cand.idempotency_key);
    if (guid) {
      await client.from("push_queue").update({
        status: "succeeded",
        tally_vch_id: guid,
        last_error: "reconciled from mirror",
        pushed_at: nowIso(),
      }).eq("id", cand.id);
      record(cand.id, cand.idempotency_key, "succeeded");
      console.log(`[pushAgent] reconciled ${cand.idempotency_key} → ${guid} (no re-push)`);
    }
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────--
export function startPushAgent(opts: { tallyUrl: string }): void {
  if (state.started) return;
  tallyUrl = opts.tallyUrl || tallyUrl;

  const url = process.env.SUPABASE_URL || "https://vmkytsytxlofjyeotmgb.supabase.co";
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    console.warn("[pushAgent] Missing SUPABASE_URL/SUPABASE_SERVICE_KEY — push agent disabled");
    return;
  }

  try {
    client = createClient(url, key, { auth: { persistSession: false } });
  } catch (err: any) {
    console.error(`[pushAgent] Failed to init Supabase client: ${err.message}`);
    return;
  }

  state.enabled = true;
  state.started = true;
  console.log(`[pushAgent] started as ${AGENT_ID} → ${tallyUrl}`);

  // Realtime INSERT → immediate drain (low latency). Polling is the real guarantee.
  try {
    client
      .channel("push_queue_inserts")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "push_queue" }, () => { void tick(); })
      .subscribe((status) => console.log(`[pushAgent] realtime: ${status}`));
  } catch (err: any) {
    console.warn(`[pushAgent] realtime subscribe failed (polling fallback active): ${err.message}`);
  }

  timers.push(setInterval(() => { void tick(); }, POLL_MS));
  timers.push(setInterval(() => { void leaseWatchdog(); }, WATCHDOG_MS));
  timers.push(setInterval(() => { void reconcile(); }, RECONCILE_MS));

  void tick(); // drain anything already queued on boot
}

export function stopPushAgent(): void {
  for (const t of timers) clearInterval(t);
  timers = [];
  state.started = false;
}

export function getPushAgentStatus() {
  return {
    enabled: state.enabled,
    agentId: AGENT_ID,
    lastTick: state.lastTick,
    tallyHealthy: state.tallyHealthy,
    claimedCount: state.claimedCount,
    last10Results: state.last10Results,
    queueStats: state.queueStats,
  };
}

/** Trigger an immediate drain tick (used by the status window's "Drain Now" button). */
export function drainNow(): void {
  void tick();
}
