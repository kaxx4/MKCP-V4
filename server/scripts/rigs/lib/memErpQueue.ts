/**
 * An in-memory ERP queue with the same rules as migration 0109, for the offline
 * test (scripts/test-queue-lease.ts) and the rigs. One machine, many boots: the
 * role lease, claim (queued or lease-expired claimed, never sent), renew, the
 * conditional sent mark with the REMOTEID registry, finish by machine, open jobs.
 * Time runs in "seconds" of `secondMs` real milliseconds so tests stay quick.
 */
import type { ErpJob, ErpQueue, LeaseInfo } from "../../../src/services/erpJobAgent.js";

export interface MemRow extends ErpJob { lease_until: number | null; remote_id: string | null; error?: string | null; master_id: string | null; booked_number?: string | null }

export function memErpQueue(opts: { machine?: string; secondMs?: number; clockOffsetMs?: number } = {}) {
  const machine = opts.machine ?? "ZZTEST-mem";
  const sec = opts.secondMs ?? 1000;
  const rows = new Map<string, MemRow>();
  const state = { kill: false, conflict: false, lease: null as null | { nonce: string; until: number }, finishFails: 0 };
  const now = () => Date.now();
  const holds = (nonce: string) => !!state.lease && state.lease.nonce === nonce && state.lease.until > now() && !state.conflict;
  let n = 0;

  const q: ErpQueue = {
    async takeLease(nonce, seconds): Promise<LeaseInfo> {
      const l = state.lease;
      if (!l || l.nonce === nonce || l.until < now()) state.lease = { nonce, until: now() + seconds * sec };
      const held = state.lease!.nonce === nonce;
      return { held, holder: machine, db_now: new Date(now() + (opts.clockOffsetMs ?? 0)).toISOString(), conflict: state.conflict, kill_switch: state.kill };
    },
    async claim(nonce, limit, leaseSeconds) {
      if (!holds(nonce)) throw new Error("claim_erp_jobs: refused: this agent does not hold the queue lease");
      if (state.kill) return [];
      const out: ErpJob[] = [];
      for (const r of rows.values()) {
        if (out.length >= limit) break;
        if (r.state === "queued" || (r.state === "claimed" && (r.lease_until ?? 0) < now())) {
          r.state = "claimed"; r.claimed_by = `${machine}#${nonce}`; r.lease_until = now() + leaseSeconds * sec; r.attempts++;
          out.push({ ...r });
        }
      }
      return out;
    },
    async renew(nonce, id, seconds) {
      const r = rows.get(id);
      if (!r || r.claimed_by !== `${machine}#${nonce}` || !["claimed", "sent"].includes(r.state)) return false;
      r.lease_until = now() + seconds * sec;
      return true;
    },
    async markSent(nonce, id) {
      if (!holds(nonce)) return { ok: false, reason: "lease lost" };
      const r = rows.get(id);
      if (!r || r.claimed_by !== `${machine}#${nonce}` || r.state !== "claimed" || (r.lease_until ?? 0) <= now()) {
        return { ok: false, reason: "the claim is no longer ours (cancelled or reclaimed); not pushed" };
      }
      if (state.kill) { r.state = "queued"; r.claimed_by = null; return { ok: false, reason: "kill switch" }; }
      const rid = String(r.payload.remoteId ?? "");
      const other = [...rows.values()].find((o) => o.id !== id && o.id !== r.resend_of && rid && (o.remote_id === rid || String(o.payload.remoteId ?? "") === rid) && o.state !== "queued");
      if (other) {
        r.state = "failed"; r.error = `Refused before Tally: REMOTEID is on another ERP job (${other.state}). Nothing was sent.`;
        return { ok: false, refused: true, reason: r.error };
      }
      r.state = "sent"; r.remote_id = rid;
      return { ok: true };
    },
    async finish(nonce, id, st, f = {}) {
      if (state.finishFails > 0) { state.finishFails--; throw new Error("erp_finish_job: simulated network failure"); }
      if (!holds(nonce)) throw new Error("erp_finish_job: refused: this agent does not hold the queue lease");
      const r = rows.get(id);
      if (!r || String(r.claimed_by ?? "").split("#")[0] !== machine) return false;
      if (!(r.state === "claimed" || (r.state === "sent" && st !== "queued"))) return false;
      r.state = st; r.master_id = f.masterId ?? r.master_id; r.booked_number = f.bookedNumber ?? r.booked_number;
      r.error = f.error ?? null; r.lease_until = null;
      if (st === "queued") r.claimed_by = null;
      return true;
    },
    async myOpenJobs() {
      return [...rows.values()].filter((r) => String(r.claimed_by ?? "").split("#")[0] === machine && ["claimed", "sent"].includes(r.state)).map((r) => ({ ...r }));
    },
  };

  return {
    queue: q, rows, state, machine,
    add(payload: ErpJob["payload"], isTest = true, resendOf: string | null = null): string {
      const id = `job-${++n}`;
      rows.set(id, { id, kind: "contra", idempotency_key: resendOf ? `resend:${resendOf}` : `proposal:${id}:v1`, payload, state: "queued", attempts: 0, is_test: isTest, resend_of: resendOf,
        claimed_by: null, lease_until: null, remote_id: null, master_id: null });
      return id;
    },
    cancel(id: string): boolean {
      const r = rows.get(id);
      if (!r || !["queued", "claimed", "held"].includes(r.state)) return false;
      r.state = "cancelled"; r.claimed_by = null; return true;
    },
    expireLease() { if (state.lease) state.lease.until = now() - 1; },
  };
}
