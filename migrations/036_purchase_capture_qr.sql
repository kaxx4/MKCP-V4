-- 036 — where a decoded invoice QR lives.
--
-- The app could parse an e-invoice JWT and an e-way bill string since August
-- (web-dashboard/src/engine/purchase/invoiceQr.ts) and knew how to reconcile
-- one against an OCR'd bill (reconcile.ts). Neither ever ran: nothing could
-- turn an image into a QR string, so both sat as tested, uncalled code. The
-- scanner now exists; this is where its result goes.
--
-- Why its own column rather than inside `extracted`:
--   `extracted` is REPLACED WHOLESALE every time a capture is re-read (see
--   migration 0034's `read` status and billEdits.ts). A QR is a property of the
--   photographed paper, not of any particular reading of it — it does not change
--   when the extraction is re-run, and it must not be destroyed by one. That is
--   the same reasoning `line_overrides` and `bill_edits` already follow, and
--   this column sits beside them deliberately.
--
-- What it holds: one QrAnchor, or null. Shape (all members nullable except the
-- first and last):
--   { kind: 'einvoice' | 'ewaybill', sellerGstin, buyerGstin, docNo, docDate,
--     docType, totalValue, itemCount, irn, ewbNo, raw }
--
-- ── What this is worth, measured rather than assumed ─────────────────────
--
-- Not much on most bills, which is the honest reason this is a nullable column
-- and not a required step. Measured over 224 real supplier invoices using the
-- exact ladder the app ships (14-Sep-2026):
--
--   MAR, 38 images  :  1 decoded (2.6%) -- e-way bill only
--   JAN+FEB, 186    : 13 decoded (7%)   -- 9 e-way bill, 4 e-invoice
--
-- An earlier version of this header, written off the 38-image run alone, said
-- zero e-invoice QRs decode. That was wrong, and the wider corpus corrected it:
-- four did, and each carried the lot -- document number, date, total and IRN
-- (e.g. 2278/2025-26, 28-Jan-2026, Rs 141,120). The dense ~800-character IRN
-- JWT is not undecodable from a phone photo; it is UNRELIABLE from one.
--
-- So: roughly 1 bill in 20 yields a vendor GSTIN and a date, and 1 in 50 yields
-- the full set. That is worth capturing and worth nothing to plan around. A
-- bill with no readable QR must import exactly as it does today, and anyone
-- sizing a matching flow on "the QR gives us number/date/total" should re-run
-- web-dashboard/scripts/measure-invoice-qr.mts before believing it.

ALTER TABLE purchase_captures
  ADD COLUMN IF NOT EXISTS qr jsonb;

COMMENT ON COLUMN purchase_captures.qr IS
  'Decoded invoice QR (QrAnchor) or null. Survives a re-read, unlike `extracted`. '
  'Measured hit rate 2.6% on the Mar-2026 corpus, e-way bill only — a bonus anchor, never required.';
