/**
 * The write gate for operator scripts (#104).
 *
 * A script under scripts/ that posts an Import or an Alter/Delete/Cancel to
 * Tally writes into whatever company that Tally has open. On the machine that
 * holds the real books that is the real books, and a duplicate company shares
 * the real one's NAME, so nothing in the XML tells the two apart. The 11
 * scripts that were already wrapped each carried their own copy of the same
 * three-line refusal; this is that refusal, once, for the rest.
 *
 * A write is allowed only when
 *   · a mock transport is installed (nothing leaves the process), or
 *   · MKCP_TALLY_ROLE=sandbox (the machine declares it holds a copy) AND
 *     TALLY_URL points at this machine (localhost / 127.0.0.1 / ::1).
 *
 * `tallyRole()` still defaults to "primary", so an unconfigured machine refuses:
 * the default behaviour of the role is unchanged, a script is simply no longer
 * able to write on it. Reads are unaffected, so this is NOT called by read-only
 * probes.
 */
import { tallyRole } from "./tallyRole.js";
import { mockTransport } from "./tallyMock.js";

const LOOPBACK = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\/?$/i;

export interface WriteVerdict { ok: boolean; reason: string }

export function scriptWriteVerdict(
  env: Record<string, string | undefined> = process.env,
  mockInstalled: boolean = mockTransport() !== null,
): WriteVerdict {
  if (mockInstalled) return { ok: true, reason: "mock transport installed, nothing reaches Tally" };
  const role = (env.MKCP_TALLY_ROLE ?? "").trim().toLowerCase();
  const url = (env.TALLY_URL || "http://localhost:9000").trim();
  if (role !== "sandbox") {
    return { ok: false, reason: `MKCP_TALLY_ROLE is "${role || "primary (default)"}", not "sandbox". This script writes to Tally and never runs against the real books.` };
  }
  if (!LOOPBACK.test(url)) {
    return { ok: false, reason: `TALLY_URL is ${url}. Only a Tally on this machine (localhost / 127.0.0.1) is allowed.` };
  }
  return { ok: true, reason: "sandbox role, loopback Tally" };
}

/** Throws with the reason when a write is not allowed. */
export function assertScriptWriteAllowed(label: string, env: Record<string, string | undefined> = process.env): void {
  const v = scriptWriteVerdict(env);
  if (!v.ok) throw new Error(`REFUSED (${label}) — ${v.reason}`);
}

/** For a script's top level: print the refusal and exit 2, the code the wrapped scripts already use. */
export function guardScriptWrites(label: string): void {
  try { assertScriptWriteAllowed(label); }
  catch (e) { console.error(`\n  ${(e as Error).message}\n`); process.exit(2); }
}
