-- Migration 048: the browser may no longer DELETE finished push_queue rows (#119).
--
-- Why: a finished row (succeeded / failed / cancelled / dismissed) is the
-- idempotency evidence. Nothing else in the schema stops the same voucher being
-- queued and pushed again once its row is gone, and there is no unique index on
-- REMOTEID. The browser's "Clear push log" used to DELETE those rows through the
-- "web clear finished" policy from 038.
--
-- What this does:
--   1. drops the "web clear finished" DELETE policy: the browser can no longer
--      delete any push_queue row;
--   2. adds hidden_at, so "clear" becomes "hide" (the activity list filters it);
--   3. lets the browser set hidden_at on FINISHED rows only, and only to a
--      timestamp (WITH CHECK ... IS NOT NULL, so it cannot un-hide a row);
--   4. a trigger stops browser roles changing anything except status and
--      hidden_at. The status change is still bounded by the existing 038 and
--      queueClient rules (failed -> dismissed; pending -> cancelled).
--
-- Re-adding the delete is a one-line policy if the owner ever wants it back.
--
-- Ordering: the web change (clearPushQueue.ts / usePushActivity.ts filter on
-- hidden_at) needs THIS migration applied first, or the activity list query
-- errors on the missing column. The owner applies it with a backup of
-- push_queue (count and export) and verifies with a read-back count.
-- NOT applied by the builder.
--
-- Self-test (owner, on a COPY, inside a transaction): as the browser role,
-- hide one succeeded row (expect 1 row updated), try to DELETE a finished row
-- (expect 0 rows and the row still present), try to set status on a pending row
-- (expect 0 rows), then ROLLBACK.

DROP POLICY IF EXISTS "web clear finished" ON public.push_queue;

ALTER TABLE public.push_queue ADD COLUMN IF NOT EXISTS hidden_at timestamptz;

DROP POLICY IF EXISTS "web hide finished" ON public.push_queue;
CREATE POLICY "web hide finished" ON public.push_queue
  FOR UPDATE TO anon, authenticated
  USING (status IN ('succeeded', 'failed', 'cancelled', 'dismissed') AND hidden_at IS NULL)
  WITH CHECK (status IN ('succeeded', 'failed', 'cancelled', 'dismissed') AND hidden_at IS NOT NULL);

CREATE OR REPLACE FUNCTION public.push_queue_browser_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- Only browser roles are limited. The agent (service role) is unchanged.
  IF current_user IN ('anon', 'authenticated') THEN
    IF (to_jsonb(NEW) - 'status' - 'hidden_at') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'hidden_at') THEN
      RAISE EXCEPTION 'push_queue: browser may change only status and hidden_at';
    END IF;
    -- A browser status change is one of the two steps the app makes today, and no other:
    --   pending -> cancelled   (cancel your own pending push; owner decision, kept)
    --   failed  -> dismissed   (set aside a failed row)
    -- Any other move (e.g. a finished row flipped to another finished status, or a row
    -- moved back to pending) is refused.
    IF NEW.status IS DISTINCT FROM OLD.status
       AND NOT ((OLD.status = 'pending' AND NEW.status = 'cancelled')
                OR (OLD.status = 'failed' AND NEW.status = 'dismissed')) THEN
      RAISE EXCEPTION 'push_queue: browser may not move a row from % to %', OLD.status, NEW.status;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS push_queue_browser_guard ON public.push_queue;
CREATE TRIGGER push_queue_browser_guard
  BEFORE UPDATE ON public.push_queue
  FOR EACH ROW EXECUTE FUNCTION public.push_queue_browser_guard();

REVOKE ALL ON FUNCTION public.push_queue_browser_guard() FROM PUBLIC;

NOTIFY pgrst, 'reload schema';
