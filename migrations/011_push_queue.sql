-- 011_push_queue.sql
-- Push-to-Tally job queue + atomic claim function.
-- Producer (enqueue) and consumer (server/src/services/pushAgent.ts) share this table.
-- The agent connects with the service-role key, so RLS is enabled with NO policies
-- (anon/publishable clients in the renderer can never read or write the queue).
-- Additive only: creates one new table + one function. Nothing existing is altered.

create extension if not exists pgcrypto;

create table if not exists public.push_queue (
  id               uuid primary key default gen_random_uuid(),
  company          text        not null,
  payload          jsonb       not null,                     -- a VoucherPayload (see server/src/types.ts)
  idempotency_key  text        not null,                     -- stamped into payload.reference → Tally <REFERENCE>
  priority         int         not null default 100,         -- lower = sooner
  status           text        not null default 'pending'
                     check (status in ('pending','claimed','pushing','succeeded','failed')),
  attempts         int         not null default 0,
  max_attempts     int         not null default 5,
  not_before       timestamptz not null default now(),       -- backoff gate
  claimed_by       text,
  claimed_at       timestamptz,
  lease_until      timestamptz,
  last_error       text,
  result           jsonb,                                    -- PushResult from voucherPusher
  tally_vch_id     text,                                     -- Tally LASTVCHID once created
  created_at       timestamptz not null default now(),
  pushed_at        timestamptz
);

-- One queue row per logical voucher. Enforces idempotent enqueue and, combined with
-- claim_push_jobs' FOR UPDATE SKIP LOCKED + reconciliation, guarantees no duplicate push.
create unique index if not exists ux_push_queue_idempotency_key
  on public.push_queue (idempotency_key);

-- Supports the claim ordering (status='pending' rows ordered by priority, created_at).
create index if not exists ix_push_queue_claim
  on public.push_queue (priority, created_at)
  where status = 'pending';

-- Supports the lease watchdog (status in claimed/pushing with an expired lease).
create index if not exists ix_push_queue_lease
  on public.push_queue (lease_until)
  where status in ('claimed','pushing');

-- Server-only access: service role bypasses RLS; everyone else is denied (no policies).
alter table public.push_queue enable row level security;

-- Realtime is a latency optimisation; the agent's poll interval is the real guarantee.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'push_queue'
  ) then
    execute 'alter publication supabase_realtime add table public.push_queue';
  end if;
exception when undefined_object then
  -- publication not present in this project; polling fallback covers it
  null;
end $$;

-- ── Atomic claim ────────────────────────────────────────────────────────────────
-- Concurrent/restarted agents never grab the same row (FOR UPDATE SKIP LOCKED).
create or replace function public.claim_push_jobs(p_agent text, p_limit int, p_lease_seconds int)
returns setof public.push_queue language plpgsql as $$
begin
  return query
  update public.push_queue q set
    status = 'claimed',
    claimed_by = p_agent,
    claimed_at = now(),
    lease_until = now() + make_interval(secs => p_lease_seconds)
  where q.id in (
    select id from public.push_queue
    where status = 'pending' and not_before <= now()
    order by priority, created_at
    limit p_limit
    for update skip locked
  )
  returning q.*;
end $$;
