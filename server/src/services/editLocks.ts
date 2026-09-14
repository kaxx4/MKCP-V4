/**
 * Who is editing what, so two people cannot silently overwrite each other.
 *
 * ── The failure this prevents ─────────────────────────────────────────────
 *
 * The front end will be open on several devices. Two people open the same
 * voucher, both push, and the second Alter wins — on the same REMOTEID it
 * succeeds either way, so neither person is told anything happened. The first
 * person's work is gone and the books look fine.
 *
 * ── The three decisions, and why ──────────────────────────────────────────
 *
 * **Locked on remote_id.** It is the only handle Tally accepts for an edit, so
 * it is the only identifier that names the thing actually at risk.
 *
 * **Expires rather than released.** Tabs close, laptops sleep, networks drop.
 * A lock released only on purpose becomes a permanent one held by someone who
 * went home, and the fix is always a human deleting a row. So it dies on its
 * own 90 seconds after the last heartbeat — and expiry is measured from the
 * HEARTBEAT, never from acquisition, so a long edit does not lose its lock for
 * being long.
 *
 * **Override is named, not forbidden.** Sometimes the other person really has
 * gone home and the invoice really does need to go out. An absolute refusal
 * teaches the office to work around the system. So overriding is allowed,
 * recorded, and attributed — the audit trail is the control, the same decision
 * taken for approvals.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** Seconds of silence after which a lock is considered abandoned. */
export const LOCK_TTL_SECONDS = 90;
/** How often a holder should say it is still there. */
export const HEARTBEAT_SECONDS = 20;

export interface Lock {
  company: string;
  remoteId: string;
  holder: string;
  holderDevice: string | null;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
}

export type AcquireResult =
  | { ok: true; lock: Lock; took: "fresh" | "renewed" | "expired-takeover" }
  /** Someone live has it. `heldBy` is named so the UI can say who. */
  | { ok: false; heldBy: string; heldSince: string; expiresAt: string; device: string | null }
  /** The mirror is unreachable — NOT the same as "the lock is free". */
  | { ok: false; heldBy: null; heldSince: null; expiresAt: null; device: null; unavailable: string };

const rowToLock = (r: any): Lock => ({
  company: r.company, remoteId: r.remote_id, holder: r.holder,
  holderDevice: r.holder_device ?? null, acquiredAt: r.acquired_at,
  heartbeatAt: r.heartbeat_at, expiresAt: r.expires_at,
});

const inFuture = (iso: string): boolean => new Date(iso).getTime() > Date.now();

/**
 * Claim a voucher for editing, or find out who has it.
 *
 * Renewing your own lock is an acquire, not a special case — the common path is
 * "I still have this", and making that the same call means a client that
 * reconnects does not need to know whether it is resuming or starting.
 */
export async function acquireLock(
  sb: SupabaseClient | null,
  company: string, remoteId: string, holder: string, device?: string,
): Promise<AcquireResult> {
  /* No client is not a free lock. Returning ok:true here would make every
     offline machine believe it holds every lock, which is worse than no
     locking at all — it would look safe while being exactly wrong. */
  if (!sb) {
    return {
      ok: false, heldBy: null, heldSince: null, expiresAt: null, device: null,
      unavailable: "No Supabase client — cannot tell whether anyone else holds this voucher.",
    };
  }

  const { data: existing, error: readErr } = await sb
    .from("voucher_locks").select("*")
    .eq("company", company).eq("remote_id", remoteId).maybeSingle();

  if (readErr) {
    return {
      ok: false, heldBy: null, heldSince: null, expiresAt: null, device: null,
      unavailable: `Could not read the lock table: ${readErr.message}`,
    };
  }

  if (existing && inFuture(existing.expires_at) && existing.holder !== holder) {
    return {
      ok: false, heldBy: existing.holder, heldSince: existing.acquired_at,
      expiresAt: existing.expires_at, device: existing.holder_device ?? null,
    };
  }

  const took: "fresh" | "renewed" | "expired-takeover" =
    !existing ? "fresh" : existing.holder === holder ? "renewed" : "expired-takeover";

  const now = new Date();
  const row = {
    company, remote_id: remoteId, holder, holder_device: device ?? null,
    // Acquisition time is preserved on a renewal so "held since" means what it says.
    acquired_at: took === "renewed" ? existing!.acquired_at : now.toISOString(),
    heartbeat_at: now.toISOString(),
    expires_at: new Date(now.getTime() + LOCK_TTL_SECONDS * 1000).toISOString(),
  };

  const { data, error } = await sb.from("voucher_locks")
    .upsert(row, { onConflict: "company,remote_id" }).select().single();

  if (error) {
    return {
      ok: false, heldBy: null, heldSince: null, expiresAt: null, device: null,
      unavailable: `Could not take the lock: ${error.message}`,
    };
  }
  return { ok: true, lock: rowToLock(data), took };
}

/** Still here. Cheap, and the only thing keeping the lock alive. */
export async function heartbeat(
  sb: SupabaseClient | null, company: string, remoteId: string, holder: string,
): Promise<boolean> {
  if (!sb) return false;
  const now = new Date();
  const { data, error } = await sb.from("voucher_locks")
    .update({
      heartbeat_at: now.toISOString(),
      expires_at: new Date(now.getTime() + LOCK_TTL_SECONDS * 1000).toISOString(),
    })
    /* Scoped to the holder: a heartbeat must never resurrect a lock that has
       already been taken over, or the two clients both believe they hold it. */
    .eq("company", company).eq("remote_id", remoteId).eq("holder", holder)
    .select();
  return !error && (data?.length ?? 0) > 0;
}

/** Done editing. Best-effort — expiry is what actually guarantees release. */
export async function releaseLock(
  sb: SupabaseClient | null, company: string, remoteId: string, holder: string,
): Promise<void> {
  if (!sb) return;
  await sb.from("voucher_locks").delete()
    .eq("company", company).eq("remote_id", remoteId).eq("holder", holder);
}

/**
 * Take a live lock from someone else, on purpose, with a reason.
 *
 * The previous holder is recorded rather than erased. "Who took my lock and
 * when" must always have an answer, or override becomes the thing people
 * quietly blame for lost work.
 */
export async function overrideLock(
  sb: SupabaseClient | null,
  company: string, remoteId: string, newHolder: string, reason: string, device?: string,
): Promise<AcquireResult> {
  if (!sb) {
    return {
      ok: false, heldBy: null, heldSince: null, expiresAt: null, device: null,
      unavailable: "No Supabase client — cannot override a lock that cannot be read.",
    };
  }
  if (!reason.trim()) {
    return {
      ok: false, heldBy: null, heldSince: null, expiresAt: null, device: null,
      unavailable: "An override needs a reason. Taking someone's work without one is how this becomes untraceable.",
    };
  }

  const { data: existing } = await sb.from("voucher_locks").select("*")
    .eq("company", company).eq("remote_id", remoteId).maybeSingle();

  const now = new Date();
  const { data, error } = await sb.from("voucher_locks").upsert({
    company, remote_id: remoteId, holder: newHolder, holder_device: device ?? null,
    acquired_at: now.toISOString(), heartbeat_at: now.toISOString(),
    expires_at: new Date(now.getTime() + LOCK_TTL_SECONDS * 1000).toISOString(),
    overridden_from: existing?.holder ?? null,
    overridden_at: existing ? now.toISOString() : null,
    override_reason: existing ? reason : null,
  }, { onConflict: "company,remote_id" }).select().single();

  if (error) {
    return {
      ok: false, heldBy: null, heldSince: null, expiresAt: null, device: null,
      unavailable: `Could not override: ${error.message}`,
    };
  }
  return { ok: true, lock: rowToLock(data), took: "expired-takeover" };
}

/** Everything currently held, for a status surface. Expired rows are excluded. */
export async function activeLocks(sb: SupabaseClient | null, company: string): Promise<Lock[]> {
  if (!sb) return [];
  const { data } = await sb.from("voucher_locks").select("*")
    .eq("company", company).gt("expires_at", new Date().toISOString());
  return (data ?? []).map(rowToLock);
}

/**
 * Delete rows that expired long ago.
 *
 * Not required for correctness — every read already filters on expiry — so this
 * is housekeeping, and it deliberately leaves a margin rather than deleting
 * everything expired: a row that died two seconds ago is still the best
 * explanation for "it said someone had it".
 */
export async function sweepExpiredLocks(sb: SupabaseClient | null, olderThanMinutes = 60): Promise<number> {
  if (!sb) return 0;
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000).toISOString();
  const { data } = await sb.from("voucher_locks").delete().lt("expires_at", cutoff).select();
  return data?.length ?? 0;
}
