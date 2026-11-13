/**
 * JOB: what a read of Tally can PROVE about a job that may already have been done (a resend, or a job left `sent` with its reply lost).
 * D-M.258 item 1.
 *
 * The old rule was "the voucher is in Tally, so it is done". That is right for a Create and wrong for any action whose target already exists
 * BEFORE the action:
 *   Cancel  the voucher is there before and after; only its cancelled flag changes.
 *   Delete  the voucher is there before; after, it is gone.
 *   Alter   the voucher is there before and after; only its fields change (the read matches the payload field by field, so a match IS the end state).
 * So the proof for each action is the END state, read fresh from the pinned company, and "the voucher exists" is proof only for a Create or Alter.
 *
 * Pure: the read is done by the caller (findInTally); nothing here talks to Tally.
 */
import type { VoucherPayload } from "../types.js";

/** One voucher the read found. `cancelled` is Tally's ISCANCELLED flag; absent means the read did not say (never proof of a cancel). */
export interface FoundVoucher { masterId: string; cancelled?: boolean }

export type EndStateProof =
  /** The end state is in Tally: the job's work is done. */
  | { done: true; masterId: string | null; how: string }
  /** The end state is NOT in Tally and nothing is doubtful: the action has not happened, so it may be sent. */
  | { done: false; ambiguous: false; how: string }
  /** The read cannot tell (twins, no number, the target missing): a person decides; nothing is sent. */
  | { done: false; ambiguous: true; how: string };

const actionOf = (p: VoucherPayload): "Create" | "Alter" | "Cancel" | "Delete" => p.action ?? "Create";

/** Is the action one that is proved by the voucher's DISAPPEARING or changing, not by its existing? */
export function targetExistsBefore(p: VoucherPayload): boolean {
  const a = actionOf(p);
  return a === "Cancel" || a === "Delete" || a === "Alter";
}

/**
 * What the job's own record can say about the voucher beyond what this read shows (D-M.263 item 1).
 * `postedBySystem`: the record proves the voucher was once posted by this system (the job carries the voucher's MASTERID, or the push's reply
 * named it). A Delete is settled "done" on an empty read only when this is true: a wrong number reads empty too, and "nothing to delete" is not
 * "deleted". Absent or false: an empty read of a Delete is ambiguous (a person checks).
 */
export interface ProofContext { postedBySystem?: boolean }

export function endStateProof(p: VoucherPayload, found: FoundVoucher[], ctx: ProofContext = {}): EndStateProof {
  const action = actionOf(p);
  const hasNumber = !!String(p.voucherNumber ?? "").trim();
  if (action === "Cancel") {
    if (!hasNumber) return { done: false, ambiguous: true, how: "it carries no voucher number, so a read cannot tell which voucher it meant to cancel" };
    if (found.length === 0) return { done: false, ambiguous: true, how: "the voucher to cancel is not in Tally, so there is nothing to cancel; a person must check it" };
    if (found.length > 1) return { done: false, ambiguous: true, how: `found ${found.length} times in Tally; a person must decide` };
    if (found[0].cancelled === true) return { done: true, masterId: found[0].masterId, how: "the voucher is in Tally and reads back cancelled" };
    return { done: false, ambiguous: false, how: "the voucher is still live in Tally (not cancelled), so the cancel has not happened" };
  }
  if (action === "Delete") {
    if (!hasNumber) return { done: false, ambiguous: true, how: "it carries no voucher number, so a read cannot tell that the voucher is gone" };
    if (found.length === 0) {
      if (!ctx.postedBySystem) return { done: false, ambiguous: true, how: "the voucher is not in Tally, but nothing in this job's own record shows it was ever posted by this system (a wrong number reads the same), so it is not settled as deleted; a person must check" };
      return { done: true, masterId: null, how: "the voucher is no longer in Tally" };
    }
    return { done: false, ambiguous: false, how: `the voucher is still in Tally (${found.length} found), so the delete has not happened` };
  }
  // Create and Alter: the read matches the payload field by field, so one match is the end state.
  if (found.length === 0) return { done: false, ambiguous: false, how: "not found in Tally" };
  if (!hasNumber) return { done: false, ambiguous: true, how: `it carries no voucher number; ${found.length} voucher(s) in Tally match on date, type, party and amount, and a read cannot tell which is this one` };
  if (found.length > 1) return { done: false, ambiguous: true, how: `found ${found.length} times in Tally; a person must decide` };
  return { done: true, masterId: found[0].masterId, how: "found exactly once in Tally by type, date, number, party and amount" };
}
