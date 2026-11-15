/**
 * JOB: a one-function hook so the company pin (inside the primary loops) can ask the preflight reporter to report again without importing it
 * (the reporter imports the loops, so a direct import would be a cycle). D-M.286.
 */
let nudge: (() => void) | null = null;
export const setPreflightNudge = (fn: (() => void) | null): void => { nudge = fn; };
/** Called when a company pin fails. Never throws. */
export const firePreflightNudge = (): void => { try { nudge?.(); } catch { /* a missed report is sent by the next periodic one */ } };
