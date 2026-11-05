/**
 * The ONLY place this process builds a Supabase client.
 *
 * ── Why a chokepoint rather than nine guards ──────────────────────────────
 *
 * `createClient` used to be called in nine modules. Making "this machine must
 * not touch Supabase" true meant remembering to guard all nine — and the tenth,
 * whenever someone added it. A guard you have to remember is not a guard.
 *
 * Now every caller comes through here, and `scripts/test-offline-mode.ts` fails
 * the build if a direct `createClient(` reappears anywhere else in `src/`. That
 * turns a convention into something enforced.
 *
 * ── Offline mode ──────────────────────────────────────────────────────────
 *
 * `MKCP_OFFLINE=true` makes this return `null`, always. Every caller already
 * handles a null client — they had to, because the service key is optional —
 * so the whole Supabase surface simply stops existing.
 *
 * That is what makes a full dummy session possible: this computer holds Tally
 * open on a DUPLICATE company, while the real books run elsewhere and sync to
 * the same project. Vouchers can be pulled, pushed, altered and cancelled
 * against the local Tally all day with no possibility of a row reaching the
 * shared mirror.
 *
 * A machine declared `MKCP_TALLY_ROLE=sandbox` is offline automatically — a
 * copy of the company has no business writing to shared state, and the two
 * settings would otherwise have to be kept in step by hand.
 */
import os from "node:os";
import { createClient, type SupabaseClient, type SupabaseClientOptions } from "@supabase/supabase-js";
import { isSandbox } from "./tallyRole.js";

export const DEFAULT_SUPABASE_URL = "https://vmkytsytxlofjyeotmgb.supabase.co";

/** True when this process must not contact Supabase at all. */
export function isOffline(): boolean {
  if ((process.env.MKCP_OFFLINE ?? "").trim().toLowerCase() === "true") return true;
  // A copy of the company is offline by definition — see tallyRole.ts.
  return isSandbox();
}

/** Why, in one line, for a log or a status endpoint. */
export function offlineReason(): string | null {
  if ((process.env.MKCP_OFFLINE ?? "").trim().toLowerCase() === "true") return "MKCP_OFFLINE=true";
  if (isSandbox()) return "MKCP_TALLY_ROLE=sandbox";
  return null;
}

let warned = false;

/**
 * A service-role client, or `null`.
 *
 * Null means one of: offline mode, or no service key configured. Callers must
 * treat both the same way — carry on doing whatever they can without Supabase —
 * which every existing caller already does.
 */
export function supabaseClient(options?: SupabaseClientOptions<"public">): SupabaseClient | null {
  if (isOffline()) {
    if (!warned) {
      warned = true;
      console.log(`🔌 [offline] Supabase is disabled (${offlineReason()}). Tally still works normally.`);
    }
    return null;
  }
  const url = process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!key) return null;
  /* `persistSession: false` on every client: this is a server process with no
     browser storage, and a client that tries to persist a session here writes
     nothing and warns. Callers may add realtime options on top. */
  return createClient(url, key, { auth: { persistSession: false }, ...(options ?? {}) });
}

/* ── The ERP test queue (rebuild task 1-0, 5-Nov-2026, D-1-0.1v) ──────────
   There is no bench project. End-to-end push tests write only to the new ERP
   table `erp_push_queue_test` on the live project, which the office agent never
   reads. The laptop (sandbox) may reach that one table and its functions, and
   nothing else: `supabaseClient()` above stays null on a sandbox, and this
   second client sends every request through `erpTestFence`, which refuses any
   path that is not on the list below BEFORE it leaves the process. So the real
   `push_queue`, `claim_push_jobs`, the mirror and every other table stay out of
   reach even though the key in hand is the service key. */

/** The only functions the test-queue client may call. */
export const ERP_TEST_RPCS: readonly string[] = [
  "enqueue_erp_test_job", "claim_erp_test_jobs", "renew_erp_test_job",
  "mark_erp_test_job_sent", "finish_erp_test_job", "cancel_erp_test_job", "erp_stale_test_rows",
  /* Task 1-3: the ERP queue's agent calls (migration 0109). Each one checks the
     machine's own key in the database, and a sandbox key reaches only ZZ TEST
     jobs, so this list is a second fence, not the only one (review M3). */
  "erp_agent_take_lease", "claim_erp_jobs", "erp_renew_job", "erp_mark_job_sent",
  "erp_finish_job", "erp_my_open_jobs", "erp_enqueue_test_job", "erp_cancel_test_job",
  /* Task 1-4 (migration 0114): test numbers only. The database checks the
     sandbox key, a ZZTEST company key and a test series. */
  "erp_take_test_voucher_number",
  /* Task 1-5 (migration 0116): the ERP mirror sync. The database lets the
     sandbox key sync only a ZZTEST company key, as test rows, into the ERP's
     own erp_mirror_rows; the tally_* mirror is never reachable from here. */
  "erp_sync_run_start", "erp_sync_run_step", "erp_sync_stage", "erp_sync_swap",
  "erp_sync_run_fail", "erp_sync_test_cleanup",
];
/** ERP mirror tables the sandbox may read (GET only, only is_test rows), task 1-5. */
export const ERP_TEST_READ_TABLES: readonly string[] = [
  "erp_sync_runs", "erp_sync_run_steps", "erp_sync_marks", "erp_mirror_stage", "erp_mirror_rows",
];
/** ERP tables the sandbox may read (only is_test rows) and clean up (only rows it names). */
export const ERP_TEST_ROW_TABLES: readonly string[] = ["erp_jobs", "erp_proposal_requests", "erp_proposals"];
/** The only table it may name directly, for reading a job and deleting its own test rows. */
export const ERP_TEST_TABLE = "erp_push_queue_test";

/**
 * Pure: may the test-queue client send this request? Null when allowed, else the refusal.
 * Allowed: POST to /rest/v1/rpc/<one of ERP_TEST_RPCS>; GET or DELETE on
 * /rest/v1/erp_push_queue_test, a DELETE only with `is_test=eq.true` and a filter
 * naming its own rows (`testDeleteNamesItsRows`).
 * The host must be the configured project's host.
 */
export function erpTestFence(url: string, method: string, projectUrl: string): string | null {
  let u: URL, p: URL;
  try { u = new URL(url); p = new URL(projectUrl); } catch { return `refused: not a URL (${url})`; }
  if (u.host !== p.host) return `refused: host ${u.host} is not the project host`;
  const m = (method || "GET").toUpperCase();
  const path = u.pathname.replace(/\/+$/, "");
  const rpc = /^\/rest\/v1\/rpc\/([a-z_][a-z0-9_]*)$/.exec(path);
  if (rpc) {
    if (m !== "POST") return `refused: ${m} on rpc ${rpc[1]}`;
    return ERP_TEST_RPCS.includes(rpc[1]) ? null
      : `refused: rpc ${rpc[1]} is not an ERP test-queue function. The sandbox laptop may not call it.`;
  }
  if (path === `/rest/v1/${ERP_TEST_TABLE}`) {
    if (m === "GET" || m === "HEAD") return null;
    if (m === "DELETE") {
      if (u.searchParams.get("is_test") !== "eq.true") return "refused: a delete on the test queue must filter is_test=eq.true";
      return testDeleteNamesItsRows(u.searchParams) ? null
        : "refused: a delete on the test queue must also name its own rows (id, or idempotency_key equal to one key or starting with a run's own prefix), so one cleanup never removes another run's rows";
    }
    return `refused: ${m} on ${ERP_TEST_TABLE}; writes go through its functions`;
  }
  const t = /^\/rest\/v1\/([a-z_]+)$/.exec(path)?.[1];
  if (t && ERP_TEST_ROW_TABLES.includes(t)) {
    if (u.searchParams.get("is_test") !== "eq.true") return `refused: the sandbox reads and removes only is_test rows of ${t}`;
    if (m === "GET" || m === "HEAD") return null;
    if (m === "DELETE") return /^in\.\([^()*%]+\)$|^eq\.[^,()*%]+$/.test(u.searchParams.get(t === "erp_proposal_requests" ? "request_id" : "id") ?? "") ? null
      : `refused: a delete on ${t} must name its rows by id`;
    return `refused: ${m} on ${t}; jobs change only through the queue functions`;
  }
  if (t && ERP_TEST_READ_TABLES.includes(t)) {
    if (u.searchParams.get("is_test") !== "eq.true") return `refused: the sandbox reads only is_test rows of ${t}`;
    if (m === "GET" || m === "HEAD") return null;
    return `refused: ${m} on ${t}; the mirror sync changes only through its functions`;
  }
  return `refused: ${path} is outside the ERP test queue. The sandbox laptop reaches nothing else.`;
}

/**
 * Pure: does a DELETE's query name the rows of one run? (coordinator review L6)
 * Accepted: `id=eq.<x>`, `id=in.(<x,...>)`, `idempotency_key=eq.<key>` or
 * `in.(...)`, or `idempotency_key=like.<prefix>*` where the prefix is a run's
 * own (ZZTEST plus at least 6 more characters), never the bare ZZTEST mark.
 */
export function testDeleteNamesItsRows(q: URLSearchParams): boolean {
  const id = q.get("id") ?? "";
  if (/^eq\.[^,()*%]+$/.test(id) || /^in\.\([^()*%]+\)$/.test(id)) return true;
  const key = q.get("idempotency_key") ?? "";
  if (/^eq\.ZZTEST[^*%]*$/.test(key) || /^in\.\(ZZTEST[^()*%]*\)$/.test(key)) return true;
  const like = /^like\.(ZZTEST[^*%]*)[*%]$/.exec(key);
  return !!like && like[1].length >= 12;
}

/** Why the test-queue client is unavailable on this machine, or null when it may be built. */
export function erpTestQueueRefusal(env: Record<string, string | undefined> = process.env): string | null {
  if ((env.MKCP_TALLY_ROLE ?? "").trim().toLowerCase() !== "sandbox") {
    return "refused: the ERP test queue is for the sandbox laptop only (MKCP_TALLY_ROLE is not sandbox).";
  }
  if ((env.MKCP_ERP_TEST_QUEUE ?? "").trim().toLowerCase() !== "on") {
    return "refused: MKCP_ERP_TEST_QUEUE is not on. Set it for the one test process only.";
  }
  if (!(env.MKCP_PRACTICE_COMPANY ?? "").trim() || !(env.MKCP_PRACTICE_COMPANY_GUID ?? "").trim()) {
    return "refused: the practice company name and GUID must both be set, so pushes can only reach the dummy.";
  }
  if (!env.SUPABASE_SERVICE_KEY) return "refused: SUPABASE_SERVICE_KEY is not set.";
  if (!(env.MKCP_ERP_AGENT_KEY ?? "").trim()) {
    return "refused: MKCP_ERP_AGENT_KEY is not set. The database refuses the test queue without this machine's registered key (task 1-3).";
  }
  return null;
}

/**
 * This machine's id on the ERP queue (the database names a claim by machine and
 * boot). Set MKCP_AGENT_MACHINE_ID to a neutral name such as `sandbox-laptop-1`
 * or `office-pc-1`, never the Windows host name (review L6, 5-Nov-2026). Unset,
 * it is `unnamed-machine`, which no database row registers, so the queue refuses it.
 *
 * The key (MKCP_ERP_AGENT_KEY) is 32 random bytes as hex, made on the machine
 * itself: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
 * Only its sha-256 goes to the database (`register_erp_machine`, a signed-in
 * Owner, or a migration); the key stays in that machine's `.env`.
 */
export function agentMachineId(env: Record<string, string | undefined> = process.env): string {
  const raw = (env.MKCP_AGENT_MACHINE_ID ?? "").trim() || "unnamed-machine";
  return raw.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 64);
}

/** This machine's ERP queue key, or a thrown refusal (never logged, never sent anywhere but the database). */
export function agentMachineKey(env: Record<string, string | undefined> = process.env): string {
  const k = (env.MKCP_ERP_AGENT_KEY ?? "").trim();
  if (!k) throw new Error("MKCP_ERP_AGENT_KEY is not set: this machine cannot work the ERP queue");
  return k;
}

/** A Supabase client that can reach only the ERP test queue, or a thrown refusal. */
export function erpTestQueueClient(fetchImpl: typeof fetch = fetch): SupabaseClient {
  const why = erpTestQueueRefusal();
  if (why) throw new Error(why);
  const url = process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL;
  const fenced: typeof fetch = async (input, init) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    const method = init?.method ?? (typeof input === "object" && "method" in (input as Request) ? (input as Request).method : "GET");
    const refusal = erpTestFence(href, method, url);
    if (refusal) throw new Error(`[erpTestQueue] ${refusal}`);
    return fetchImpl(input as any, init);
  };
  return createClient(url, process.env.SUPABASE_SERVICE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: fenced },
  });
}

/**
 * For the two callers that legitimately want to fail loudly rather than degrade
 * — a diagnostic script is useless if it silently reports nothing.
 */
export function requireSupabase(what: string): SupabaseClient {
  const c = supabaseClient();
  if (!c) {
    const why = offlineReason() ?? "SUPABASE_SERVICE_KEY is not set";
    throw new Error(`${what} needs Supabase, but it is unavailable (${why}).`);
  }
  return c;
}
