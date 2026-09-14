-- Migration 032: edit locks on vouchers.
--
-- APPLIED 13-Sep-2026 as Supabase migration `voucher_edit_locks`.
-- Verified by use: server/scripts/verify-edit-locks.ts, 19 of 19.
--
-- The front end will be open on several devices, syncing many times a minute.
-- Two people opening the same voucher today both push, and the second Alter
-- silently overwrites the first — on the same REMOTEID it succeeds either way,
-- so neither person is told. The first person's work is gone and the books
-- look fine.
--
-- Locked on remote_id because that is the only handle Tally accepts for an
-- edit, so it is the only identifier that names the thing actually at risk.
--
-- Expires rather than being released: tabs close, laptops sleep, networks drop,
-- and a lock released only on purpose becomes a permanent one held by someone
-- who went home. Expiry is derived from heartbeat_at and never from
-- acquired_at, so a long edit does not lose its lock for being long.
--
-- Override is allowed, recorded and ATTRIBUTED rather than forbidden.
-- Sometimes the other person really has gone home and the invoice really does
-- need to go out; an absolute refusal teaches the office to work around the
-- system. The previous holder is kept, not erased — "who took my lock and when"
-- must always have an answer.

CREATE TABLE IF NOT EXISTS voucher_locks (
  company        text NOT NULL,
  remote_id      text NOT NULL,
  holder         text NOT NULL,
  holder_device  text,
  acquired_at    timestamptz NOT NULL DEFAULT now(),
  heartbeat_at   timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL DEFAULT now() + interval '90 seconds',
  overridden_from text,
  overridden_at   timestamptz,
  override_reason text,
  PRIMARY KEY (company, remote_id)
);

CREATE INDEX IF NOT EXISTS idx_voucher_locks_expiry ON voucher_locks (expires_at);
