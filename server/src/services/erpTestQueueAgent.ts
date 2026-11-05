/**
 * JOB: the sandbox laptop's claim path for the ERP test queue (rebuild task 1-0).
 *
 * There is no bench project (D-1-0.1v). An end-to-end push test puts a ZZ TEST
 * job on `erp_push_queue_test`; this module, and only on the sandbox laptop,
 * claims it, books it into the DUMMY company through `safePush` (guard, push,
 * read back, diff), and writes the outcome. It never reads `push_queue`: the
 * queue it is handed is either the fenced live client (`erpTestQueueClient()`,
 * which refuses every other table and function before sending) or an
 * in-memory queue for the offline rigs.
 *
 * What it refuses, before Tally is contacted:
 *   · any machine that is not sandbox, or a job whose company is not the
 *     practice company (safePush also refuses, and tallyPost checks the GUID);
 *   · a payload without the ZZTEST mark on its number and narration, or with no
 *     REMOTEID (the sweep must be able to find and remove what it booked).
 *
 * Outcomes follow the plan's queue words (file 06 section 7): `succeeded` when the
 * read-back matches, `readback_differs` when Tally stored something else,
 * `failed` when the guard or Tally refused (nothing booked), `uncertain` when the
 * call threw after `sent` (Tally may hold it; never retried by itself).
 * Task 1-3 builds the full agent (lease renewal, journal, settling); this is
 * the smallest path that proves the test queue end to end.
 */
import os from "node:os";
import { safePush, type SafePushResult } from "./safePush.js";
import { isSandbox, practiceCompany } from "./tallyRole.js";
import type { VoucherPayload } from "../types.js";

export interface TestJob {
  id: string;
  idempotency_key: string;
  label: string;
  company: string;
  payload: VoucherPayload;
  state: string;
  attempts: number;
}

export type TestOutcome = "succeeded" | "failed" | "readback_differs" | "uncertain";

/** The seam between this agent and wherever the test queue lives. */
export interface TestQueue {
  claim(agent: string, limit: number, leaseSeconds: number): Promise<TestJob[]>;
  markSent(id: string, agent: string): Promise<boolean>;
  finish(id: string, agent: string, state: TestOutcome, fields: {
    masterId?: string | null; voucherNumber?: string | null; result?: unknown; error?: string | null;
  }): Promise<boolean>;
}

/** Identity: the machine, not the process (file 03 1-3 item 4). */
export const TEST_AGENT_ID = `${os.hostname()}#erp-test`;

/** Pure: why this job must not be pushed from here, or null. */
export function testJobRefusal(job: Pick<TestJob, "company" | "payload" | "label">, env = process.env): string | null {
  if ((env.MKCP_TALLY_ROLE ?? "").trim().toLowerCase() !== "sandbox") return "refused: not a sandbox machine";
  const practice = (env.MKCP_PRACTICE_COMPANY ?? "").trim();
  if (!practice || job.company.trim() !== practice) return "refused: the job's company is not the practice company";
  const p = job.payload ?? ({} as VoucherPayload);
  if (!String(job.label ?? "").startsWith("ZZ TEST")) return "refused: the job is not labelled ZZ TEST";
  if (!String(p.voucherNumber ?? "").startsWith("ZZTEST")) return "refused: the voucher number does not carry the ZZTEST mark";
  if (!String(p.narration ?? "").includes("ZZTEST")) return "refused: the narration does not carry the ZZTEST mark";
  if (!String(p.remoteId ?? "").trim()) return "refused: no REMOTEID, so the sweep could not remove it";
  if ((p.action ?? "Create") !== "Create") return "refused: test jobs only create";
  return null;
}

/** Pure: the outcome word for a safePush result. */
export function outcomeOf(res: SafePushResult): TestOutcome {
  if (res.ok) return "succeeded";
  if (res.differences.length) return "readback_differs";
  return "failed";
}

export interface RunReport { claimed: number; results: { id: string; key: string; outcome: TestOutcome | "refused" | "lost-claim"; detail: string; voucherId?: string | null }[] }

type Pusher = (tallyUrl: string, company: string, payload: VoucherPayload) => Promise<SafePushResult>;

/** Claim and book up to `limit` jobs, one Tally write at a time. */
export async function runErpTestQueueOnce(queue: TestQueue, opts: {
  tallyUrl: string; agent?: string; limit?: number; leaseSeconds?: number; push?: Pusher;
}): Promise<RunReport> {
  if (!isSandbox()) throw new Error("runErpTestQueueOnce: refused, this machine is not sandbox");
  const agent = opts.agent ?? TEST_AGENT_ID;
  const push = opts.push ?? ((u, c, p) => safePush(u, c, p));
  const jobs = await queue.claim(agent, opts.limit ?? 1, opts.leaseSeconds ?? 120);
  const report: RunReport = { claimed: jobs.length, results: [] };
  for (const job of jobs) {
    const key = job.idempotency_key;
    const refusal = testJobRefusal(job);
    if (refusal) {
      await queue.finish(job.id, agent, "failed", { error: refusal });
      report.results.push({ id: job.id, key, outcome: "refused", detail: refusal });
      continue;
    }
    // `sent` before the call: a cancel or a reclaim that got there first wins.
    if (!(await queue.markSent(job.id, agent))) {
      report.results.push({ id: job.id, key, outcome: "lost-claim", detail: "the claim was no longer ours; not pushed" });
      continue;
    }
    let res: SafePushResult;
    try {
      res = await push(opts.tallyUrl, practiceCompany()!, job.payload);
    } catch (e) {
      const msg = `no answer from Tally after sending: ${(e as Error).message}. It may be in the books; not retried.`;
      await queue.finish(job.id, agent, "uncertain", { error: msg });
      report.results.push({ id: job.id, key, outcome: "uncertain", detail: msg });
      continue;
    }
    const outcome = outcomeOf(res);
    const detail = outcome === "succeeded" ? "read back and matched"
      : outcome === "readback_differs" ? `stored differently: ${res.differences.join("; ")}`
      : res.errors.join("; ") || "push failed";
    await queue.finish(job.id, agent, outcome, {
      masterId: res.voucherId, voucherNumber: job.payload.voucherNumber ?? null,
      result: { stage: res.stage, warnings: res.warnings, differences: res.differences, errors: res.errors },
      error: outcome === "succeeded" ? null : detail,
    });
    report.results.push({ id: job.id, key, outcome, detail, voucherId: res.voucherId });
  }
  return report;
}

/** The live test queue, through the fenced client. */
export function supabaseTestQueue(c: { rpc: (fn: string, args: Record<string, unknown>) => any }): TestQueue {
  const call = async <T>(fn: string, args: Record<string, unknown>): Promise<T> => {
    const { data, error } = await c.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data as T;
  };
  return {
    claim: (agent, limit, lease) => call<TestJob[]>("claim_erp_test_jobs", { p_agent: agent, p_limit: limit, p_lease_seconds: lease }),
    markSent: (id, agent) => call<boolean>("mark_erp_test_job_sent", { p_id: id, p_agent: agent }),
    finish: (id, agent, state, f) => call<boolean>("finish_erp_test_job", {
      p_id: id, p_agent: agent, p_state: state, p_master_id: f.masterId ?? null,
      p_voucher_number: f.voucherNumber ?? null, p_result: f.result ?? null, p_error: f.error ?? null,
    }),
  };
}

/** An in-memory test queue with the same claim rules, for the offline rigs. */
export function memoryTestQueue(jobs: TestJob[]): TestQueue & { rows: Map<string, TestJob & { claimed_by?: string | null; lease_until?: number; outcome?: unknown }> } {
  const rows = new Map(jobs.map((j) => [j.id, { ...j }] as const)) as Map<string, any>;
  return {
    rows,
    async claim(agent, limit, lease) {
      const now = Date.now();
      const out: TestJob[] = [];
      for (const r of rows.values()) {
        if (out.length >= limit) break;
        if (r.state === "queued" || (r.state === "claimed" && (r.lease_until ?? 0) < now)) {
          Object.assign(r, { state: "claimed", claimed_by: agent, lease_until: now + lease * 1000, attempts: r.attempts + 1 });
          out.push({ ...r });
        }
      }
      return out;
    },
    async markSent(id, agent) {
      const r = rows.get(id);
      if (!r || r.claimed_by !== agent || r.state !== "claimed" || (r.lease_until ?? 0) <= Date.now()) return false;
      r.state = "sent"; return true;
    },
    async finish(id, agent, state, f) {
      const r = rows.get(id);
      if (!r || r.claimed_by !== agent || !["claimed", "sent"].includes(r.state)) return false;
      r.state = state; r.outcome = f; return true;
    },
  };
}
