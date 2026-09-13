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
export interface RealtimeOptions {
  /** How often to look at all. Masters are checked every tick. */
  tickMs?: number;
  /** Vouchers cost ~4s per scan, so they are checked every Nth tick, not every tick. */
  voucherEvery?: number;
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
  private status: RealtimeStatus = {
    running: false, company: null, cursor: null, ticks: 0,
    lastTickAt: null, lastChangeAt: null, vouchersApplied: 0,
    skipped: { busy: 0, tooMany: 0 }, lastError: null,
    cursorSource: null, cursorNote: null,
  };

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
    if (this.timer) return;
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
      const checkVouchers = this.ticks % this.opts.voucherEvery === 0;

      const mastersMoved = await this.detector.mastersChangedSince(this.tallyUrl, this.company, this.cursor);
      if (mastersMoved) {
        console.log("[realtime] masters changed — refreshing");
        await this.orchestrator.syncMastersOnly(this.company);
        const fresh = await this.detector.fetchCurrentAlterIds(this.tallyUrl, this.company);
        this.cursor = { ...this.cursor, masterId: fresh.masterId };
        this.status.lastChangeAt = new Date().toISOString();
      }

      if (checkVouchers) {
        const changed = await this.detector.whatChanged(this.tallyUrl, this.company, this.cursor);
        const n = changed.vouchers.count;
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
