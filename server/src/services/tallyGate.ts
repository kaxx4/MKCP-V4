/**
 * The gate every write to Tally passes through.
 *
 * Tally's XML port is single-threaded and fragile in a specific way: a malformed
 * or unexpected request raises a MODAL DIALOG in the desktop application, and
 * while that dialog is up the port accepts connections but never answers. From
 * the outside this looks like a hang, and every subsequent request piles up
 * behind it. Recovering means a human restarting Tally.
 *
 * So this does three things:
 *
 *  1. **Serialises.** One write at a time, no exceptions. Two concurrent
 *     requests on a single-threaded port is how a hang starts.
 *  2. **Breaks the circuit.** After a transport failure it stops accepting work
 *     rather than hammering a port that is probably behind a dialog. Queued
 *     callers are told immediately instead of timing out one by one.
 *  3. **Recovers deliberately.** The circuit only closes again when a cheap
 *     health probe actually succeeds — never on a timer, never optimistically.
 */
import { tallyPost, HEALTH_XML } from "../tally.js";

export type GateState = "closed" | "open" | "probing";

let chain: Promise<unknown> = Promise.resolve();
let state: GateState = "closed";
let lastFailure: { at: number; reason: string } | null = null;
let consecutiveFailures = 0;

/** Tally needs a moment to settle between writes; without it rapid-fire
 *  imports have been seen to interleave badly on a single-threaded port. */
const SETTLE_MS = 120;
/** After this many transport failures in a row, stop trying entirely. */
const BREAK_AFTER = 2;
/**
 * How long to wait between recovery probes while the circuit is open.
 *
 * The probe is what closes the circuit, and something has to run it. Doing so
 * on every rejected call would hammer a port that is probably behind a dialog —
 * the exact thing breaking the circuit was meant to stop — so a write arriving
 * at an open gate triggers at most one probe per cooldown, and every other
 * caller in that window is refused immediately as before.
 */
const RECOVERY_PROBE_COOLDOWN_MS = 15_000;

let lastProbeAt = 0;
/** Shared so concurrent callers arriving at an open gate run ONE probe, not N. */
let inFlightProbe: Promise<boolean> | null = null;

export class TallyUnavailableError extends Error {
  constructor(reason: string) {
    super(`Tally is not accepting writes: ${reason}. It is most likely showing a dialog — check the Tally window; it may need restarting.`);
    this.name = "TallyUnavailableError";
  }
}

export function gateState(): { state: GateState; consecutiveFailures: number; lastFailure: typeof lastFailure } {
  return { state, consecutiveFailures, lastFailure };
}

/** Force the gate shut again — for an operator who has just fixed Tally. */
export function resetGate(): void {
  state = "closed";
  consecutiveFailures = 0;
  lastFailure = null;
}

/** Is Tally answering at all? Cheap, and never queued behind the gate. */
export async function probe(tallyUrl: string, timeoutMs = 10_000): Promise<boolean> {
  try {
    await tallyPost(tallyUrl, HEALTH_XML, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run one piece of Tally work, serialised behind every other.
 *
 * `fn` should perform exactly one request. Anything that throws is treated as a
 * possible transport failure and counts toward opening the circuit; a rejection
 * Tally *answered* (a rejected voucher) should be returned normally by `fn`, not
 * thrown, so it does not look like the port died.
 */
export async function withTally<T>(tallyUrl: string, label: string, fn: () => Promise<T>): Promise<T> {
  if (state === "open") {
    // Give recovery a chance before refusing. Until this existed the circuit
    // was a one-way door: `withTally` was the only thing that ever OPENED it,
    // and the only route to `tryRecover` was `assertWritable`, whose one
    // non-script caller (bulkEntry) is unreachable. So two consecutive
    // transport failures made every later safePush throw until the process was
    // restarted — including the failures that happen routinely when an
    // operator has Tally showing a dialog and then clears it.
    await maybeRecover(tallyUrl);
    if (state === "open") {
      throw new TallyUnavailableError(lastFailure?.reason ?? "a previous request failed");
    }
  }

  const run = chain.then(async () => {
    // Re-check inside the queue: the request ahead of us may have broken it.
    if (state === "open") throw new TallyUnavailableError(lastFailure?.reason ?? "a previous request failed");
    try {
      const out = await fn();
      consecutiveFailures = 0;
      return out;
    } catch (e) {
      consecutiveFailures++;
      lastFailure = { at: Date.now(), reason: (e as Error).message };
      if (consecutiveFailures >= BREAK_AFTER) {
        state = "open";
        console.error(`[tallyGate] circuit OPEN after ${consecutiveFailures} failures — refusing further writes until a probe succeeds. Last: ${label}: ${(e as Error).message}`);
      }
      throw e;
    } finally {
      if (SETTLE_MS > 0) await new Promise(r => setTimeout(r, SETTLE_MS));
    }
  });

  // Keep the chain alive regardless of this call's outcome, so one failure does
  // not wedge every later caller behind a rejected promise.
  chain = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * Try to close the circuit again, but only on real evidence.
 *
 * Returns true when Tally answered. Deliberately not on a timer: if a dialog is
 * up, time alone changes nothing and retrying just queues more requests behind it.
 */
export async function tryRecover(tallyUrl: string): Promise<boolean> {
  if (state === "closed") return true;
  if (inFlightProbe) return inFlightProbe;

  lastProbeAt = Date.now();
  state = "probing";
  inFlightProbe = (async () => {
    try {
      const alive = await probe(tallyUrl);
      if (alive) {
        console.log("[tallyGate] probe succeeded — circuit closed, writes resume.");
        resetGate();
        return true;
      }
      state = "open";
      return false;
    } finally {
      inFlightProbe = null;
    }
  })();
  return inFlightProbe;
}

/**
 * Rate-limited recovery, for callers that hit an open gate on the way to doing
 * real work. Probing on EVERY refused write would queue requests behind the
 * dialog we are trying to stay off; probing on a timer would run forever in a
 * process nobody is using. Once per cooldown, driven by real demand, is both.
 */
async function maybeRecover(tallyUrl: string): Promise<void> {
  if (state !== "open") return;
  if (inFlightProbe) { await inFlightProbe; return; }
  if (Date.now() - lastProbeAt < RECOVERY_PROBE_COOLDOWN_MS) return;
  await tryRecover(tallyUrl);
}

/**
 * Guard a batch: refuse to start at all unless Tally is answering.
 *
 * Cheaper to find out before writing 60 vouchers than on the 31st.
 */
export async function assertWritable(tallyUrl: string): Promise<void> {
  if (state === "open" && !(await tryRecover(tallyUrl))) {
    throw new TallyUnavailableError(lastFailure?.reason ?? "circuit is open");
  }
  if (!(await probe(tallyUrl))) {
    state = "open";
    lastFailure = { at: Date.now(), reason: "health probe failed" };
    throw new TallyUnavailableError("it did not answer a health check");
  }
}
