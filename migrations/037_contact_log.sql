-- 037 — who we called, and what happened.
--
-- The collections view has recorded every call, WhatsApp and note since it was
-- built, into `localStorage` under "mkc-collections-log". That means:
--
--   · the owner's phone and the accountant's desktop each hold a different
--     answer to "have we chased this party", and neither knows about the other;
--   · clearing site data, switching browser, or a new device loses the lot,
--     silently, with no way to tell it happened;
--   · nothing else in the system can see it — the who-to-call ranking cannot
--     avoid a party somebody already rang an hour ago.
--
-- The plan names this explicitly: the contact log must move off localStorage.
--
-- ── Shape ────────────────────────────────────────────────────────────────
--
-- One row per contact attempt, append-only. Not a "last contacted" column on
-- the party: the question people actually ask is "what have we tried", and a
-- single timestamp cannot answer it. Append-only also means two devices adding
-- rows concurrently never overwrite each other, which a last-write-wins column
-- would.
--
-- `channel` is constrained rather than free text, because a ranking that has to
-- treat "call"/"Call"/"phoned" as three things is a ranking that quietly
-- undercounts. `outcome` stays free text — it is a note to a human.
--
-- ── Access ───────────────────────────────────────────────────────────────
--
-- Direct browser writes under RLS, following file_transfers / purchase_captures
-- / shipments, which are the existing direct-write tables. Their policies are
-- plain `true` and this one matches them: there is no login in this app, so a
-- policy that pretends to identify a user would be theatre.
--
-- Deliberately NOT keyed off `user_profiles`. That table's own SELECT policy
-- queries `user_profiles`, so it recurses — measured 14-Sep-2026, the browser
-- key cannot read any of the eleven tables whose policies reference it
-- ("infinite recursion detected in policy for relation user_profiles"). Copying
-- that pattern here would produce a table nothing can read, which is exactly
-- the failure this migration exists to end.

CREATE TABLE IF NOT EXISTS contact_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company     text NOT NULL,
  ledger_id   text NOT NULL,
  party_name  text,
  channel     text NOT NULL CHECK (channel IN ('call', 'whatsapp', 'email', 'note')),
  outcome     text,
  -- Which device logged it. There is no login; this is the honest limit of
  -- what can be claimed, and the UI says "this device" rather than a name.
  logged_by   text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- The only query this table serves: one party's history, newest first, and the
-- whole company's recent activity for the who-to-call ranking.
CREATE INDEX IF NOT EXISTS contact_log_party_idx
  ON contact_log (company, ledger_id, created_at DESC);
CREATE INDEX IF NOT EXISTS contact_log_recent_idx
  ON contact_log (company, created_at DESC);

ALTER TABLE contact_log ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'contact_log' AND policyname = 'contact log read') THEN
    CREATE POLICY "contact log read" ON contact_log FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'contact_log' AND policyname = 'contact log write') THEN
    CREATE POLICY "contact log write" ON contact_log FOR INSERT WITH CHECK (true);
  END IF;
  -- No UPDATE and no DELETE policy, on purpose. A contact log that can be
  -- edited after the fact answers "what have we tried" less reliably than one
  -- that cannot, and nothing in the product needs to change a past entry.
END $$;

COMMENT ON TABLE contact_log IS
  'Append-only record of collection contact attempts. Replaces the per-device localStorage log ("mkc-collections-log"), which was invisible across devices and lost on a cache clear.';
