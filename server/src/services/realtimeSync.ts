/**
 * Near-real-time pull: keep Supabase level with Tally without a nightly rebuild.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 * Every piece needed for incremental sync was already written and none of it
 * ran. `ChangeDetector` returned 0/0 forever (AltMstId/AltVchId are not valid
 * methods), so no baseline ever existed. `syncChangedVouchers` bails when the
 * watermark is 0. `mode: "incremental"` is requested by no production caller.
 * The result: the dashboard lagged the books by up to a day, and the only pull
 * that ran was a midnight full sync plus a 30-minute tick that needed the
 * Electron window open.
 *
 * This is the missing part — something that holds a cursor and drives the loop.
 *
 * ── What it costs, measured ───────────────────────────────────────────────
 *   vouchers, nothing changed ...  1 KB,  4.0 s
 *   ledgers,  nothing changed ...  1 KB,  98 ms
 *
 * The payload is free; the cost is CPU on Tally's SINGLE-THREADED port. A
 * 4-second voucher scan every 30 seconds is ~13% of that port's time, which is
 * the upper end of tolerable while a person is working in Tally. So: masters are
 * polled every tick (cheap), vouchers only every `VOUCHER_EVERY` ticks, and the
 * whole loop stands down while Tally is busy with a human-facing sync.
 *
 * ── Polling less, smartly (owner, 20-Nov-2026) ───────────────────────────
 * Measured again on the laptop's Tally: the voucher check is a flat ~4.7 s scan
 * of every voucher whether or not anything changed, and narrowing it by date does
 * not help (Tally scans them all either way). So the lever is HOW OFTEN, not how
 * big. The voucher check now backs off while nothing changes (every third empty
 * scan doubles the wait, up to `voucherMaxEveryMs`) and snaps back to the fast
 * rate the moment a voucher or a master changes, or `nudge()` is called (a push
 * just landed, a person pressed Sync). Masters stay on every tick: 0.12 s.
 */
import { tallyPost } from "../tally.js";
import { convertCompanies } from "../converters/convert.js";
import { HEALTH_XML } from "../tally.js";
import { ChangeDetector } from "./changeDetector.js";
import { isTallyBusy } from "./tallyBusy.js";
import type { SyncOrchestrator } from "./syncOrchestrator.js";
import type { SupabaseSync } from "./supabaseSync.js";
import type { AlterIdSnapshot } from "../types.js";
import { mirrorVoucherWatermark, resolveVoucherCursor, type CursorSource } from "./syncCursor.js";

/**
 * Tuning. Read at CONSTRUCTION, not at import — module-level env constants
 * freeze on first import, which makes the loop impossible to reconfigure or to
 * test without restarting the process.
 */
/**
 * How many ticks to wait before the next voucher check. Pure, so the schedule can be tested without a Tally.
 * `idleScans` is how many checks in a row found nothing. Every third one doubles the wait, from `every` up to `maxTicks`.
 */
export function nextVoucherStep(every: number, maxTicks: number, idleScans: number): number {
  const base = Math.max(1, Math.floor(every));
  const doubled = base * 2 ** Math.floor(Math.max(0, idleScans) / 3);
  return Math.max(base, Math.min(Math.max(1, Math.floor(maxTicks)), doubled));
}

export interface RealtimeOptions {
  /** How often to look at all. Masters are checked every tick. */
  tickMs?: number;
  /** Vouchers cost ~4s per scan, so they are checked every Nth tick, not every tick. */
  voucherEvery?: number;
  /** The longest the voucher check may wait while nothing changes. */
  voucherMaxEveryMs?: number;
  /**
   * Refuse to fetch detail for more than this many changed vouchers at once.
   * A full year WITH entry blocks exceeded 300s and wedged the port — a valid
   * request, just too large. Beyond this the right answer is a scheduled sync.
   */
  maxChanged?: number;
}

const DEFAULTS = {
  tickMs: Number(process.env.REALTIME_TICK_MS ?? 30_000),
  voucherEvery: Number(process.env.REALTIME_VOUCHER_EVERY ?? 2),
  voucherMaxEveryMs: Number(process.env.REALTIME_VOUCHER_MAX_EVERY_MS ?? 300_000),
  maxChanged: Number(process.env.REALTIME_MAX_CHANGED ?? 400),
};

export interface RealtimeStatus {
  running: boolean;
  company: string | null;
  cursor: AlterIdSnapshot | null;
  ticks: number;
  lastTickAt: string | null;
  lastChangeAt: string | null;
  vouchersApplied: number;
  skipped: { busy: number; tooMany: number };
  /** Voucher checks made, and how many ticks the next one waits (it grows while nothing changes). */
  voucherChecks: number;
  voucherWaitTicks: number;
  lastError: string | null;
  /* Where the voucher cursor came from. "tally-now" means restarts can skip
     edits made while the agent was down — a status a human should be able to
     see rather than infer from a log line that scrolled past. */
  cursorSource: CursorSource | null;
  cursorNote: string | null;
}

export class RealtimeSync {
  private timer: NodeJS.Timeout | null = null;
  private detector = new ChangeDetector();
  private cursor: AlterIdSnapshot | null = null;
  private company: string | null = null;
  private ticks = 0;
  private inFlight = false;
  private starting = false;
  /** After a failed masters refresh, do not look again until this tick, so a broken upload is not retried every few seconds. */
  private mastersRetryTick = 0;
  private status: RealtimeStatus = {
    running: false, company: null, cursor: null, ticks: 0,
    lastTickAt: null, lastChangeAt: null, vouchersApplied: 0,
    skipped: { busy: 0, tooMany: 0 }, voucherChecks: 0, voucherWaitTicks: 0, lastError: null,
    cursorSource: null, cursorNote: null,
  };
  /** The tick on which the next voucher check is due, and how many checks in a row found nothing. */
  private nextVoucherTick = 0;
  private idleVoucherChecks = 0;

  private cursorSource: CursorSource | null = null;

  private readonly opts: Required<RealtimeOptions>;

  constructor(
    private tallyUrl: string,
    private orchestrator: SyncOrchestrator,
    private supabase: SupabaseSync | null,
    opts: RealtimeOptions = {},
  ) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  getStatus(): RealtimeStatus {
    return { ...this.status, cursor: this.cursor, ticks: this.ticks, running: this.timer !== null };
  }

  async start(): Promise<void> {
    // The timer is only set after two awaits, so a second start() in that window used to pass this guard and make a second timer that stop() could not clear.
    if (this.timer || this.starting) return;
    this.starting = true;
    try {
      await this.begin();
    } finally {
      this.starting = false;
    }
  }

  private async begin(): Promise<void> {
    try {
      this.company = convertCompanies(await tallyPost(this.tallyUrl, HEALTH_XML, 10_000))[0]?.name ?? null;
      if (!this.company) { console.warn("[realtime] no company loaded — not starting"); return; }

      const tallyNow = await this.detector.fetchCurrentAlterIds(this.tallyUrl, this.company);

      /* ── Resume from the MIRROR, not from Tally's current mark ─────────────
         Seeding from `tallyNow` silently declares "everything up to now has
         been seen", so anything edited while this agent was down — overnight,
         over a weekend, during an update — sits above the old cursor and below
         the new one and is never re-read. No error, no log, a permanently wrong
         mirror for those vouchers.

         That was unavoidable while the cursor lived only in memory. Migration
         029 put alter_id on tally_vouchers, so the mirror can now answer "what
         is the highest AlterID I actually hold", which is what resuming means.
         See services/syncCursor.ts. */
      const fromMirror = await mirrorVoucherWatermark(this.supabase?.getClient() ?? null, this.company);
      const origin = resolveVoucherCursor(fromMirror, tallyNow.transactionId);

      this.cursor = { ...tallyNow, transactionId: origin.value };
      this.cursorSource = origin.source;
      this.detector.updateSnapshot(this.cursor);
      this.status.company = this.company;
      this.status.cursorSource = origin.source;
      this.status.cursorNote = origin.note;

      console.log(`[realtime] watching "${this.company}" from masters=${this.cursor.masterId} vouchers=${this.cursor.transactionId}, tick ${this.opts.tickMs}ms (vouchers every ${this.opts.voucherEvery})`);
      console.log(`[realtime] voucher cursor (${origin.source}): ${origin.note}`);
      if (origin.source !== "mirror") {
        console.warn(`[realtime] NOT resuming durably — restarts can skip edits until alter_id is populated.`);
      }
    } catch (e) {
      console.warn(`[realtime] could not establish a baseline: ${(e as Error).message}`);
      return;
    }
    this.timer = setInterval(() => void this.tick(), this.opts.tickMs);
    this.status.running = true;
  }

  /** Something is likely to have changed (a push landed, a person pressed Sync): check vouchers on the next tick and go back to the fast rate. */
  nudge(): void {
    this.idleVoucherChecks = 0;
    this.nextVoucherTick = this.ticks + 1;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.status.running = false;
  }

  private async tick(): Promise<void> {
    // Never let two ticks overlap: the port is single-threaded, and a queued
    // second scan would simply make the first one slower.
    if (this.inFlight || !this.company || !this.cursor) return;

    // Stand down while a human-facing sync is running. Competing for the port
    // makes that sync slower, and it will move the cursor past our changes anyway.
    if (isTallyBusy()) { this.status.skipped.busy++; return; }

    this.inFlight = true;
    this.ticks++;
    this.status.lastTickAt = new Date().toISOString();
    try {
      const maxTicks = Math.ceil(this.opts.voucherMaxEveryMs / Math.max(1, this.opts.tickMs));

      const mastersMoved = this.ticks >= this.mastersRetryTick
        && await this.detector.mastersChangedSince(this.tallyUrl, this.company, this.cursor);
      if (mastersMoved) {
        console.log("[realtime] masters changed — refreshing");
        // Read the new mark BEFORE the refresh: a ledger edited during a multi-second refresh then stays above the cursor and is seen next time.
        const fresh = await this.detector.fetchCurrentAlterIds(this.tallyUrl, this.company);
        const result = await this.orchestrator.syncMastersOnly(this.company);
        if (result && result.success === false) {
          // The refresh did not land (upload failed or the read came back empty). Keep the old mark so it is tried again, a minute from now.
          this.mastersRetryTick = this.ticks + Math.ceil(60_000 / Math.max(1, this.opts.tickMs));
          this.status.lastError = `masters refresh failed: ${(result.errors ?? ["no data"]).join("; ")}`.slice(0, 300);
          console.warn(`[realtime] ${this.status.lastError} — will retry`);
        } else {
          this.cursor = { ...this.cursor, masterId: fresh.masterId };
        }
        this.status.lastChangeAt = new Date().toISOString();
        // A new party or item usually comes with vouchers: look at them now and stay on the fast rate.
        this.idleVoucherChecks = 0;
        this.nextVoucherTick = this.ticks;
      }

      if (this.ticks >= this.nextVoucherTick) {
        const changed = await this.detector.whatChanged(this.tallyUrl, this.company, this.cursor);
        const n = changed.vouchers.count;
        this.status.voucherChecks++;
        this.idleVoucherChecks = n > 0 ? 0 : this.idleVoucherChecks + 1;
        this.nextVoucherTick = this.ticks + nextVoucherStep(this.opts.voucherEvery, maxTicks, this.idleVoucherChecks);
        this.status.voucherWaitTicks = this.nextVoucherTick - this.ticks;
        if (n > 0) {
          if (n > this.opts.maxChanged) {
            // Too much to be an edit — this is a restore, an import, or a first
            // run against a stale cursor. A scheduled sync is the right tool.
            console.warn(`[realtime] ${n} vouchers changed, above the ${this.opts.maxChanged} ceiling — leaving it to the scheduled sync`);
            this.status.skipped.tooMany++;
            this.cursor = { ...this.cursor, transactionId: changed.vouchers.maxAlterId };
          } else {
            console.log(`[realtime] ${n} voucher(s) changed: ${changed.vouchers.voucherNumbers.slice(0, 6).join(", ")}${n > 6 ? ` +${n - 6}` : ""}`);
            const converted = await this.orchestrator.syncChangedVouchers(this.company, this.cursor.transactionId);
            const applied = converted.tallymessage.length;
            if (applied && this.supabase) {
              // No prune range: these are individual edits scattered across the
              // year, not a window being rebuilt. Pruning by date here would
              // delete vouchers that simply did not change.
              await this.supabase.syncVouchers(converted.tallymessage, this.company);
            }
            this.status.vouchersApplied += applied;
            this.status.lastChangeAt = new Date().toISOString();
            this.cursor = { ...this.cursor, transactionId: changed.vouchers.maxAlterId };
          }
          this.detector.updateSnapshot(this.cursor);
        }
      }
      this.status.lastError = null;
    } catch (e) {
      this.status.lastError = (e as Error).message;
      console.warn(`[realtime] tick failed: ${this.status.lastError}`);
    } finally {
      this.inFlight = false;
    }
  }
}
