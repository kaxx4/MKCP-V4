/**
 * Which Tally is this machine holding — the real books, or a copy?
 *
 * ── The problem this exists for ───────────────────────────────────────────
 *
 * TWO MACHINES SHARE ONE SUPABASE MIRROR, and they cannot be told apart.
 *
 * The real books run on the owner's other computer and sync from there. This
 * repo is also run on a development machine against a DUPLICATE company — and a
 * Tally duplicate carries the SAME NAME as the original. Every mirror table is
 * keyed on that name alone, so both machines write the same rows.
 *
 * Two things follow, and both are damaging:
 *
 *   · A scheduled sync on the dev machine mirrors the SANDBOX over the real
 *     company's vouchers. The dashboard would then serve a copy's data as
 *     current, with nothing anywhere saying so.
 *   · The push agent on the dev machine would claim jobs from the shared
 *     `push_queue` and book real business vouchers into the SANDBOX — where
 *     they are lost, while the queue row reads "succeeded".
 *
 * Neither announces itself. The second is worse: an invoice someone raised on
 * the web app would simply never appear in the real books.
 *
 * ── The declaration ───────────────────────────────────────────────────────
 *
 *   MKCP_TALLY_ROLE=primary   this machine holds the real books (the default,
 *                             so existing installations behave exactly as before)
 *   MKCP_TALLY_ROLE=sandbox   this machine holds a copy — it must not write to
 *                             anything shared
 *
 * Defaulting to `primary` is deliberate. The alternative — defaulting to safe —
 * would silently stop the real machine from syncing the moment this shipped,
 * which is a worse failure than the one being prevented and much harder to
 * notice. A copy is the unusual case and is the one that declares itself.
 */

export type TallyRole = "primary" | "sandbox";

export function tallyRole(): TallyRole {
  return (process.env.MKCP_TALLY_ROLE ?? "").trim().toLowerCase() === "sandbox"
    ? "sandbox"
    : "primary";
}

export const isSandbox = (): boolean => tallyRole() === "sandbox";

/**
 * Refuse a shared write from a sandbox machine, and say why.
 *
 * Returns true when the caller should STOP. Logs once per call site rather than
 * silently returning, because a sync that quietly does nothing is the failure
 * mode this whole codebase keeps producing.
 */
export function refuseSharedWrite(what: string): boolean {
  if (!isSandbox()) return false;
  console.warn(
    `🛑 [sandbox] ${what} refused — MKCP_TALLY_ROLE=sandbox.\n` +
    `   This machine holds a COPY of the company, and the Supabase mirror is\n` +
    `   keyed on the company name, which the copy shares with the real books.\n` +
    `   Writing from here would overwrite real data with a copy's.`,
  );
  return true;
}

/**
 * The one company a sandbox machine may write to: the practice (dummy) company,
 * named by MKCP_PRACTICE_COMPANY. Null when unset or blank.
 */
export function practiceCompany(): string | null {
  const v = (process.env.MKCP_PRACTICE_COMPANY ?? "").trim();
  return v === "" ? null : v;
}

/**
 * On a sandbox machine, refuse any company that is not the practice company.
 *
 * Returns the refusal text when the write must STOP, or null when it may go on.
 * It is only ever consulted by the push path, before any XML is built or sent.
 * A primary machine is never refused here. A sandbox with no practice company
 * set refuses everything (fail closed), and says which setting is missing.
 *
 * Names are compared exactly after trimming, because Tally's names are exact:
 * a near-miss is a different company, not a typo to forgive.
 */
export function refuseCompanyWrite(company: string): string | null {
  if (!isSandbox()) return null;
  const practice = practiceCompany();
  if (practice === null) {
    return "refused: MKCP_TALLY_ROLE=sandbox but MKCP_PRACTICE_COMPANY is not set, " +
      "so no company may be written to on this machine. Set it to the practice company's name.";
  }
  if (String(company ?? "").trim() === practice) return null;
  return `refused: company "${String(company ?? "")}" is not the practice company ` +
    `("${practice}", from MKCP_PRACTICE_COMPANY). On a sandbox machine only the practice ` +
    `company may be written to.`;
}

/** One line at startup, so which machine this is never has to be guessed. */
export function announceRole(): void {
  if (isSandbox()) {
    console.log("🛑 [sandbox] MKCP_TALLY_ROLE=sandbox — scheduled syncs and push-queue draining are OFF.");
  } else {
    console.log("📒 [primary] MKCP_TALLY_ROLE=primary — this machine writes to the shared Supabase mirror.");
  }
}
