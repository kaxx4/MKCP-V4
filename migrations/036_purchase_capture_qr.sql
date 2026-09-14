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
-- Very little on most bills, and that is the honest reason it is a nullable
-- column and not a required step. Measured over 38 real supplier invoices
-- (PURCHASE INVOICES/MAR 01042026, 14-Sep-2026), using the exact ladder the app
-- ships: ONE decoded — 2.6% — and it was an e-way bill QR carrying a GSTIN and a
-- date, with no document number, no total and no IRN. Zero e-invoice (IRN) QRs
-- decoded, which confirms the earlier four-bill finding recorded in
-- invoiceQr.ts. The dense ~800-character IRN JWT does not survive a phone photo
-- of a fax-quality invoice.
--
-- So this anchors the VENDOR and sometimes the date, on a minority of bills. It
-- is a bonus, never a prerequisite: a bill with no readable QR must import
-- exactly as it does today. Anyone tempted to build a matching flow on the
-- assumption that the QR supplies number/date/total should re-run
-- web-dashboard/scripts/measure-invoice-qr.mts first.

ALTER TABLE purchase_captures
  ADD COLUMN IF NOT EXISTS qr jsonb;

COMMENT ON COLUMN purchase_captures.qr IS
  'Decoded invoice QR (QrAnchor) or null. Survives a re-read, unlike `extracted`. '
  'Measured hit rate 2.6% on the Mar-2026 corpus, e-way bill only — a bonus anchor, never required.';
