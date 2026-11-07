/**
 * How a live rig decides its exit code (review of thread 8, item 12).
 *
 * A rig that stops on a thrown error before it has recorded a failed check used to exit 0 from its `finally`, because
 * "no check failed" was read as "all passed". Three rules close that:
 *   - an error in the body is recorded as a failed check (see `recordError`);
 *   - the rig exits 0 only when the number of checks that PASSED is exactly the number it expects to make;
 *   - a read that tells whether anything is left behind fails the run when the read itself fails (see `leftoverCheck`).
 * No Tally or database access here: it is the part the offline test can run.
 */
export interface RigCheck { name: string; ok: boolean; detail: string }

/** 0 only when no check failed AND exactly `expected` checks passed. Anything else is 1. */
export function rigExitCode(results: RigCheck[], expected: number): 0 | 1 {
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  return failed === 0 && passed === expected ? 0 : 1;
}

/** One line for the end of the rig's output; names the shortfall when fewer checks ran than were expected. */
export function rigSummary(results: RigCheck[], expected: number): string {
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  const short = passed < expected && failed === 0 ? `; only ${passed} of the ${expected} expected checks ran and passed` : "";
  return `${passed} passed, ${failed} failed${short}`;
}

/** Record an error thrown by the body of a rig as a failed check, so the exit code can never be 0 after it. */
export function recordError(results: RigCheck[], e: unknown, name = "the run finished without an error"): void {
  results.push({ name, ok: false, detail: e instanceof Error ? e.message : String(e) });
}

/** The check "nothing of ours is left": a failed read is a failed check, never a count of zero. */
export function leftoverCheck(name: string, read: { count: number | null; error: { message: string } | null }): RigCheck {
  if (read.error) return { name, ok: false, detail: `could not count what is left: ${read.error.message}` };
  if (read.count === null || read.count === undefined) return { name, ok: false, detail: "the count came back empty, so nothing can be said about what is left" };
  return { name, ok: read.count === 0, detail: `${read.count} left` };
}
