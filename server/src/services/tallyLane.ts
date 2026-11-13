/**
 * JOB: "one Tally at a time" for the single-primary mode (D-M.256 item 5).
 *
 * TallyPrime's XML port is single-threaded. In primary mode several things talk to it: the queue loop (writes), the mirror loop, the masters
 * load, and the legacy nightly and scheduled syncs (reads). Before this, writes were serialised among themselves (tallyGate.ts) and pulls
 * among themselves (syncGuard), but a pull and a push could overlap, and a long pull could hold up a voucher.
 *
 * The lane sits in the one place every request passes (tallyPost in tally.ts), so EVERY caller shares it, with no change to the callers:
 *   - one request at a time, read or write;
 *   - a write waits only for the request already running, then goes BEFORE any waiting read;
 *   - reads wait in the order they came.
 * The lock is per request, not per pass, so a mirror pass of many requests is interleaved with the queue's writes instead of blocking them.
 *
 * Used only while MKCP_PRIMARY_MODE=on (tally.ts); with the mode off nothing here runs.
 */
export type LaneKind = "read" | "write";

interface Waiter { start: () => void; label: string }

export class TallyLane {
  private busy: string | null = null;
  private writes: Waiter[] = [];
  private reads: Waiter[] = [];
  /** How long each kind of request has waited, for the status and the tests. */
  stats = { reads: 0, writes: 0, maxWriteWaitMs: 0, maxReadWaitMs: 0, order: [] as string[] };

  /** What is running now, or null. */
  running(): string | null { return this.busy; }
  waiting(): { reads: number; writes: number } { return { reads: this.reads.length, writes: this.writes.length }; }

  run<T>(kind: LaneKind, label: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const queuedAt = Date.now();
      const start = (): void => {
        if (signal?.aborted) { this.release(); reject(new Error(`${label}: cancelled while waiting for Tally`)); return; }
        this.busy = label;
        const waited = Date.now() - queuedAt;
        if (kind === "write") { this.stats.writes++; this.stats.maxWriteWaitMs = Math.max(this.stats.maxWriteWaitMs, waited); }
        else { this.stats.reads++; this.stats.maxReadWaitMs = Math.max(this.stats.maxReadWaitMs, waited); }
        this.stats.order.push(`${kind}:${label}`);
        if (this.stats.order.length > 200) this.stats.order.shift();
        Promise.resolve().then(fn).then(resolve, reject).finally(() => this.release());
      };
      if (this.busy === null) start();
      else (kind === "write" ? this.writes : this.reads).push({ start, label });
    });
  }

  private release(): void {
    this.busy = null;
    const next = this.writes.shift() ?? this.reads.shift();
    if (next) next.start();
  }
}

/** The process's one lane. */
export const tallyLane = new TallyLane();
