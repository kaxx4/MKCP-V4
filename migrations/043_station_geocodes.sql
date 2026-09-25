-- Station geocodes and the owner's party -> station choices, for the truck plan.
--
-- ── Why (25-Sep-2026) ───────────────────────────────────────────────────────
--
-- The owner: "Party stations need to be mapped more accurately. Prioritise
-- searching a station name and mapping the party to that station, not the
-- party name." The map drew every dealer at one of 64 hand-typed town centroids,
-- and nothing checked them: BHUPATINAGAR sat about 16 km from the real town,
-- near the Rasulpur estuary, and KAKURDANGAMORE carried KAKDWEEP's coordinates.
--
-- The web app (MKCP MOB2, domain/partyStation.ts) now resolves each party to a
-- STATION (a town), geocodes the station once through its api/road-routes
-- endpoint (Nominatim + India Post, server-side), validates the answer
-- (domain/geocodeValidation.ts: inside the delivery area, not in water, not a
-- state centroid, in the pincode's district) and caches it here. Every party at
-- a station shares the one row, and the road route from the godown is cached
-- per station in road_routes under a key that carries the station's point.
--
-- ── Who writes ──────────────────────────────────────────────────────────────
--
-- ONLY the web app's dedicated endpoint (api/road-routes.ts), with the service
-- client, after validating the payload. Neither table goes on the generic
-- /api/upsert allowlist (WRITABLE_TABLES): cached coordinates are cheap to
-- poison and expensive to notice, the same reasoning road_routes already
-- follows. Browsers read through RLS (anon SELECT), exactly like road_routes.
--
-- ── Until this is applied ───────────────────────────────────────────────────
--
-- The app degrades, it does not break: the map reads a baked seed
-- (src/data/stationGeocodes.json, the same geocoder run over the live books on
-- 25-Sep-2026), the endpoint geocodes without storing and says `stored: false`,
-- and an owner's "set station" is kept on that device only, and says so.
--
-- Numbering continues this folder (042 was the highest). CREATE TABLE IF NOT
-- EXISTS is safe here only because no other migration in either ledger
-- declares these names (checked: no station_geocodes / party_stations in
-- MKCP MOB2/web-dashboard/supabase/migrations, nor live, 25-Sep-2026).

create table if not exists station_geocodes (
  station_key  text primary key,           -- "BHUPATINAGAR~721": town ~ pincode's first 3 digits (or state)
  town         text not null,
  district     text,
  state        text not null default 'West Bengal',
  pincode      text,
  lat          double precision,
  lng          double precision,
  status       text not null check (status in ('ok', 'uncertain', 'unresolved')),
  reasons      text[] not null default '{}',
  method       text,                       -- settlement | settlement-spaced | free-text | pincode-centre | owner
  display_name text,
  provider     text not null default 'nominatim',
  confirmed    boolean not null default false,  -- the owner said "this is right"
  updated_at   timestamptz not null default now()
);

create table if not exists party_stations (
  party_name  text primary key,            -- the Tally ledger name, as on the voucher
  town        text not null,
  district    text,
  set_by      text not null default 'owner',
  updated_at  timestamptz not null default now()
);

alter table station_geocodes enable row level security;
alter table party_stations  enable row level security;

do $$ begin
  create policy anon_read on station_geocodes for select using (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy anon_read on party_stations for select using (true);
exception when duplicate_object then null; end $$;

-- No insert/update/delete policies: writes come only from the service role.
