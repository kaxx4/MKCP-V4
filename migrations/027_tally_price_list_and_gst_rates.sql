-- Migration 027: the price list and GST rates, mirrored from Tally.
--
-- APPLIED 13-Sep-2026 as Supabase migration `tally_price_list_and_gst_rates`
-- (version 20260913174523). Verified against the live schema after applying,
-- not against this file — P5: CREATE TABLE IF NOT EXISTS is a no-op, not an
-- upgrade, so the object is what gets confirmed. The mirror now holds 4,254
-- price entries and 106 GST rates.
--
-- ── Why these are new tables rather than the existing ones ─────────────────
--
-- `tally_price_list_imports` already exists and holds one selling_rate per
-- (company, item_name). It cannot carry what Tally actually has:
--
--   FULLPRICELIST returns 4,254 DATED entries across 488 items and 2 price
--   levels — a history going back to 2003, not a snapshot. "The price" means
--   the newest entry not after a given date, which is also what lets a
--   backdated voucher price itself the way it would have at the time.
--
-- It is also explicitly WEB-OWNED (server/src/index.ts lists it among the
-- tables the desktop must not write, after its writer overwrote web data on
-- 2026-08-25). Having the agent start writing it would restart exactly that
-- fight. So the agent-owned pull lands here, and the Price List page can adopt
-- it when that page is next touched.
--
-- Same reasoning for GST rates. `src/data/gstMasterRates.json` is a checked-in
-- file with no import path at all; it can now be REGENERATED from Tally
-- (server/scripts/regen-gst-master.ts), but a file still needs a redeploy to
-- change. This table is the durable form.
--
-- ── What Tally actually gives, and why the columns look like this ─────────
--
-- Price levels: `DEALER` and `Dealer` are the SAME level, entered with
-- different capitalisation over twenty years — both spellings appear within a
-- single item's own timeline. Keyed on the raw name the catalogue splits
-- 2,549 / 1,695 and a lookup misses ~40% of the time. So `price_level` holds
-- the FOLDED name (upper-cased) and is part of the unique key, while
-- `price_level_raw` keeps what Tally holds for display.
--
-- Rates arrive as "995.24/PC" — a number AND the unit it is quoted in. Two
-- items quoted per-PC and per-BOX are not comparable, so the unit travels with
-- the rate rather than being dropped.
--
-- GST rates are DATED too (APPLICABLEFROM) and split across duty heads. IGST
-- is the COMBINED rate; CGST and SGST are halves of it. Bicycles and parts
-- moved from 12% to 5% on 22 September 2025, and 16 of 22 stock groups carry
-- three revisions — so a single "current rate" column would be wrong for any
-- voucher dated before the change. All three heads are stored, plus the
-- combined figure, so a caller can see the split instead of inferring it.
--
-- Idempotent — safe to re-run.

-- ════════════════════════════════════════════════════════════════════
-- tally_price_list — one row per (item, price level, effective date)
-- ════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS tally_price_list (
  id BIGSERIAL PRIMARY KEY,
  company TEXT NOT NULL,
  item_name TEXT NOT NULL,
  -- Folded for lookups. See the note above on DEALER vs Dealer.
  price_level TEXT NOT NULL,
  -- The spelling Tally holds, for display only. Never key on this.
  price_level_raw TEXT,
  -- The date this rate took effect (Tally's FULLPRICELIST DATE).
  effective_from DATE NOT NULL,
  rate NUMERIC(15, 4) NOT NULL,
  -- The unit the rate is quoted in, e.g. "PC" from "995.24/PC".
  unit TEXT,
  discount_pct NUMERIC(6, 3) DEFAULT 0,
  synced_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (company, item_name, price_level, effective_from)
);

-- The lookup this table exists for: "rate for this item at this level, as at
-- this date" — a descending scan on effective_from, stopped at the first row.
CREATE INDEX IF NOT EXISTS idx_tally_price_list_lookup
  ON tally_price_list (company, item_name, price_level, effective_from DESC);
CREATE INDEX IF NOT EXISTS idx_tally_price_list_company
  ON tally_price_list (company);

ALTER TABLE tally_price_list ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tally_price_list_service_write" ON public.tally_price_list;
CREATE POLICY "tally_price_list_service_write" ON public.tally_price_list
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- The browser reads with the publishable key. Without an explicit SELECT
-- policy every read silently returns zero rows — the failure mode migration
-- 023 documents for the discount tables, which looked exactly like "sync is
-- broken" for months.
DROP POLICY IF EXISTS "tally_price_list_public_read" ON public.tally_price_list;
CREATE POLICY "tally_price_list_public_read" ON public.tally_price_list
  FOR SELECT TO anon, authenticated USING (true);

-- ════════════════════════════════════════════════════════════════════
-- tally_gst_rates — one row per (scope, name, effective date)
--
-- `scope` is 'item' or 'stock_group', because a rate resolves item first and
-- then up the stock-group tree: only 36 of 489 items declare their own rate,
-- 453 inherit. Storing only the item level would lose the rate for 93% of the
-- catalogue; storing only the resolved value would lose WHERE it came from,
-- which is what the operator needs when a rate looks wrong.
-- ════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS tally_gst_rates (
  id BIGSERIAL PRIMARY KEY,
  company TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('item', 'stock_group')),
  name TEXT NOT NULL,
  -- Tally's APPLICABLEFROM. 16 of 22 stock groups carry three revisions.
  effective_from DATE NOT NULL,
  -- The COMBINED rate: IGST, or CGST + SGST when IGST is absent.
  gst_rate NUMERIC(6, 3) NOT NULL,
  cgst_rate NUMERIC(6, 3),
  sgst_rate NUMERIC(6, 3),
  igst_rate NUMERIC(6, 3),
  -- Tally's own word: "Taxable", "Exempt", "Nil Rated". Not interchangeable.
  taxability TEXT,
  -- For scope='item', the stock group it inherits from when it declares none.
  parent TEXT,
  synced_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (company, scope, name, effective_from)
);

CREATE INDEX IF NOT EXISTS idx_tally_gst_rates_lookup
  ON tally_gst_rates (company, scope, name, effective_from DESC);
CREATE INDEX IF NOT EXISTS idx_tally_gst_rates_company
  ON tally_gst_rates (company);

ALTER TABLE tally_gst_rates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tally_gst_rates_service_write" ON public.tally_gst_rates;
CREATE POLICY "tally_gst_rates_service_write" ON public.tally_gst_rates
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS "tally_gst_rates_public_read" ON public.tally_gst_rates;
CREATE POLICY "tally_gst_rates_public_read" ON public.tally_gst_rates
  FOR SELECT TO anon, authenticated USING (true);

NOTIFY pgrst, 'reload schema';
