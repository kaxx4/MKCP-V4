/**
 * The identity every voucher must carry, built the same way on both sides.
 *
 * Tally addresses an existing voucher by `REMOTEID`, and **only by one the
 * caller assigned at creation** — a GUID or VCHKEY will not do it, and a
 * voucher written without one can never be altered, converted or deleted.
 * Proved exhaustively on 2026-09-11, and again on 2026-09-12 when every
 * remaining candidate handle (MASTERID, VOUCHERKEY, GUID) was tried on a
 * voucher that had none: all rejected.
 *
 * This mirrors `engine/push/remoteId.ts` in the web app, byte for byte, so a
 * voucher built here and the same voucher built there resolve to the SAME id.
 * If they drifted, the agent could not alter what the web app created, and a
 * re-push would duplicate rather than being refused.
 *
 * A stable key — rather than a random one — is also what makes a re-push
 * idempotent: pushing the same voucher twice alters the first instead of
 * booking the money again.
 */

/** Strip characters that would need escaping, so the id survives the attribute. */
const clean = (s: string): string => String(s ?? "").replace(/["'<>&]/g, "").trim();

/** Indian financial year label for a date, e.g. "2026-27" for 1 April 2026 on. */
export function financialYearOf(iso: string): string {
  const [y, m] = iso.split("-").map(Number);
  if (!y || !m) return "";
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

/**
 * Build a voucher's identity.
 *
 * Keyed on what identifies the document to a person — its type and number
 * within a financial year — so the same voucher always resolves to the same id
 * whichever surface pushed it.
 *
 * ⚠ Because the TYPE is part of the key, never rebuild an id for a voucher
 * whose type has changed (an order billed into an invoice). Carry the original.
 */
export function remoteIdFor(input: {
  voucherType: string;
  voucherNumber: string;
  /** YYYY-MM-DD. Only the financial year is used, so re-dating within one keeps identity. */
  date?: string;
}): string {
  const fy = input.date ? financialYearOf(input.date) : "";
  return ["MKCP", clean(input.voucherType), clean(input.voucherNumber), fy]
    .filter(Boolean)
    .join("|");
}
