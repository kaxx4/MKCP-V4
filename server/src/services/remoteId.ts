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
import { xmlSafeText } from "./xml.js";

/** Strip characters that would need escaping, so the id survives the attribute. */
/* XML-P1: also strip C0 controls, U+FFFE/FFFF and lone surrogates — XML cannot
   carry them. Same rule as the web app's engine/push/remoteId.ts so ids agree. */
const clean = (s: string): string => xmlSafeText(String(s ?? "")).replace(/[\x00-\x1F]/g, "").replace(/["'<>&]/g, "").trim();

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
  /**
   * Task 1-4: the `erp_jobs` id, used only when there is no number. Before 1-4
   * an unnumbered voucher got `MKCP|Journal|2026-27`, the same id for every one
   * of them, so the second ALTERED the first in Tally.
   */
  jobId?: string;
}): string {
  const fy = input.date ? financialYearOf(input.date) : "";
  const jobKey = clean(input.jobId ?? "") ? `job-${clean(input.jobId ?? "")}` : "";
  const key = clean(input.voucherNumber) || jobKey;
  /* 1-4: never an id with nothing unique after the type. An empty id is
     refused by the guard as "no remoteId"; a shared one silently overwrites. */
  if (!key) return "";
  return ["MKCP", clean(input.voucherType), key, fy]
    .filter(Boolean)
    .join("|");
}

/**
 * Does this REMOTEID name ONE voucher? Ours (`MKCP|<type>|...`) needs a part
 * after the type that is not just the financial year; any other spelling needs
 * to be non-empty. pushGuard refuses a Create that fails this (file 18 row 1-4).
 * Same rule as the web app's engine/push/remoteId.ts.
 */
export function remoteIdHasUniquePart(remoteId: string | null | undefined): boolean {
  const id = String(remoteId ?? "").trim();
  if (!id) return false;
  const parts = id.split("|");
  if (parts[0] !== "MKCP") return true;
  return parts.slice(2).some((p) => p.trim() !== "" && !/^\d{4}-\d{2}$/.test(p.trim()));
}
