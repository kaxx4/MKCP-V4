/**
 * JOB: pace and protect a long rig's use of Tally (coordinator ruling D-M.180).
 *
 * TallyPrime on the dummy stopped on 12-Nov-2026 after four hours of back-to-back 30 to 60 second reads. Two rules:
 *
 *   1. PACE. One "turn" is one thing a rig asks of Tally: a push with its read-back, one voucher read, the census,
 *      a master create or delete, the open-bills read. The next turn does not start until `minGapMs` (default
 *      120 seconds) after the last one ENDED, so Tally rests between requests.
 *   2. LIVENESS. Before every turn, and after any turn that threw, a plain GET on the Tally port must answer.
 *      If it does not answer twice (15 seconds apart), the gate goes "down": it throws `TallyDownError` and every
 *      later turn throws at once. The rig catches that, stops cleanly, sends nothing more, and prints what is left
 *      in the books and the exact cleanup command. It never tries to restart Tally.
 *
 * Pure apart from the clock, the sleeper and the ping, all passed in, so the offline test runs it with a fake clock.
 */

export class TallyDownError extends Error {
  constructor(public readonly during: string, public readonly detail: string) {
    super(`Tally stopped answering during "${during}"${detail ? ` (${detail})` : ""}`);
    this.name = "TallyDownError";
  }
}

export interface GateOptions {
  /** Minimum time from the end of one turn to the start of the next. */
  minGapMs: number;
  /** True when Tally answers a plain request on its port. */
  ping: () => Promise<boolean>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Wait between the two liveness tries. */
  retryPingMs?: number;
  log?: (line: string) => void;
}

export class TallyGate {
  down: TallyDownError | null = null;
  turns = 0;
  waitedMs = 0;
  private lastEnd = 0;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  constructor(private readonly o: GateOptions) {
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private async alive(): Promise<boolean> {
    if (await this.o.ping()) return true;
    await this.sleep(this.o.retryPingMs ?? 15_000);
    return this.o.ping();
  }

  /** Run one turn. Throws `TallyDownError` (and keeps throwing it) once Tally has stopped answering. */
  async run<T>(label: string, fn: () => Promise<T>): Promise<T> {
    if (this.down) throw this.down;
    if (this.turns > 0) {
      const wait = this.lastEnd + this.o.minGapMs - this.now();
      if (wait > 0) {
        this.o.log?.(`  (resting ${Math.ceil(wait / 1000)} s: Tally is asked at most once every ${Math.round(this.o.minGapMs / 1000)} s)`);
        this.waitedMs += wait;
        await this.sleep(wait);
      }
    }
    if (!(await this.alive())) { this.down = new TallyDownError(label, "no answer on its port before the request"); throw this.down; }
    this.turns++;
    try {
      return await fn();
    } catch (e) {
      // A failed request may be a refusal from Tally (fine) or Tally going away (stop).
      if (!(await this.alive())) { this.down = new TallyDownError(label, (e as Error).message.slice(0, 120)); throw this.down; }
      throw e;
    } finally {
      this.lastEnd = this.now();
    }
  }
}

/** Seconds from `--min-gap-sec N` (default 120; 0 turns the pacing off, the liveness check stays). */
export function minGapFromArgv(argv: string[]): number {
  const i = argv.indexOf("--min-gap-sec");
  if (i < 0) return 120_000;
  const n = Number(argv[i + 1]);
  return Number.isFinite(n) && n >= 0 ? n * 1000 : 120_000;
}

/** A plain GET on the Tally port: any HTTP answer means it is up (Tally says "TallyPrime Server is Running"). */
export async function httpPing(url: string, timeoutMs = 8_000): Promise<boolean> {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) }); await r.text(); return true; }
  catch { return false; }
}
