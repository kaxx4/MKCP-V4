/**
 * CASH-P2 — give the Cash SALES vouchers already in the mirror their real
 * buyer, from the running agent, with nobody at the office machine.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 * CASH-P1 (0d8a293) made new syncs mirror the buyer behind a Cash bill
 * (PARTYMAILINGNAME + ADDRESS.LIST → buyer_* columns, migration 043). But a
 * normal sync skips re-upserting any voucher whose AlterID did not move, so the
 * Cash bills mirrored before CASH-P1 never get their buyer.
 * `scripts/backfill-cash-buyers.ts` fixes that by hand; it needed a person on
 * the office machine. This is the same logic (moved here, G1 — the script now
 * imports it) run by the agent itself, once a day.
 *
 * ── The rules it keeps, and why ───────────────────────────────────────────
 * - READ-ONLY toward Tally. One Export/Collection request per DAY, header
 *   scalars only. No import of any kind (owner, binding: "dont push anything
 *   to the main office tally"). `cashBuyerDayRequest` refuses to return
 *   anything that is not an Export, and the offline test pins it.
 * - ONE DAY PER REQUEST, never a range: entry-block pulls must stay within a
 *   single day, and a year-wide detail pull has wedged Tally (tally-pull-
 *   performance). This request carries no entry blocks at all.
 * - A pause between days, and every request through `withTally` so it queues
 *   behind pushes instead of racing them on Tally's single-threaded port.
 * - STOP AT THE FIRST TALLY ERROR. After an error TallyPrime's port is dead
 *   until a human restarts it (tally-error-requires-restart); retrying only
 *   hides that. The stop is persisted and retried no sooner than tomorrow.
 * - Writes ONLY the six buyer_* columns, by company + GUID, on rows the mirror
 *   listed as Cash + buyer-less. Never inserts, never deletes, never touches
 *   another column; a voucher whose buyer reads back entirely empty is not
 *   written at all.
 * - primary only. A sandbox holds a COPY that shares production's name; its
 *   buyer must never land on the real mirror. `refuseSharedWrite` says so, and
 *   `supabaseClient()` is null there anyway.
 *
 * ── Logging (P8: the evidence of failure, not of success) ─────────────────
 * - Every Tally failure is in server/data/tally-log.jsonl with request and
 *   response, because the request goes through tallyPost.
 * - A STOPPED run writes one `tally_sync_history` row (sync_type
 *   "cash_buyer_backfill", success=false). A successful run writes NONE: a
 *   success row there is read by the web as "the data is fresh" and clears
 *   its failing banner, and a buyer backfill pulls no new data — the "fresh
 *   chip hides it" mistake (mirror-misses-backdated-vouchers). Same choice as
 *   nightlySync, which logs failures only.
 * - Progress lines on the console under 🧾 [CASH-BUYER], and the per-day done
 *   list in server/data/cash-buyer-backfill-state.json (survives restarts).
 *
 * Env: CASH_BUYER_BACKFILL_ENABLED ("false" disables), CASH_BUYER_BACKFILL_HOUR
 * (local hour, default 19 — after the 18:00 price/GST pull, away from the 10am
 * money and noon invoice rush), CASH_BUYER_BACKFILL_MAX_DAYS (per run, default 30).
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tallyPost } from "../tally.js";
import { buildCollection, onDate } from "./tallyRequest.js";
import { convertVouchers } from "../converters/convert.js";
import { supabaseClient } from "./supabaseClient.js";
import { refuseSharedWrite, tallyRole } from "./tallyRole.js";
import { withTally } from "./tallyGate.js";
import { isTallyBusy } from "./tallyBusy.js";
import { resolveSyncCompany, fyStartYmd, todayYmd } from "./scheduledSyncs.js";

export const SYNC_TYPE = "cash_buyer_backfill";

/** Header scalars only. Every name is live-verified (collections.ts, CASH-P1 note). */
export const CASH_BUYER_FETCH = [
  "Guid", "Date", "VoucherNumber", "VoucherTypeName", "PartyLedgerName", "AlterID",
  "PartyMailingName", "Address", "PartyPincode", "StateName", "BasicBuyerName", "BasicBuyerAddress",
];
export const BUYER_KEYS = ["buyer_name", "buyer_address", "buyer_pincode", "buyer_pincode_source", "buyer_place", "buyer_state"] as const;
export type BuyerPatch = Record<(typeof BUYER_KEYS)[number], string | null>;

export const isCashLedger = (s: unknown): boolean => /^cash$/i.test(String(s ?? "").trim());

/**
 * The ONE request this job sends: one day's vouchers, header scalars only.
 * Throws rather than return anything that is not a read.
 */
export function cashBuyerDayRequest(company: string, day: string): string {
  if (!/^\d{8}$/.test(day)) throw new Error(`cashBuyerDayRequest: day must be YYYYMMDD, got "${day}"`);
  const xml = buildCollection({ id: "MkcpCashBuyer", type: "Voucher", company, fetch: CASH_BUYER_FETCH, filter: onDate(day) });
  if (!/<TALLYREQUEST>Export<\/TALLYREQUEST>/.test(xml) || /<TALLYREQUEST>\s*Import/i.test(xml) || /<IMPORTDATA>/i.test(xml)) {
    throw new Error("cashBuyerDayRequest: refusing a non-Export request — this job never writes to Tally.");
  }
  return xml;
}

/** Mirror rows (guid, ISO date) → YYYYMMDD → the GUIDs that need a buyer. */
export function groupPendingByDay(rows: readonly { guid: unknown; date: unknown }[]): Map<string, Set<string>> {
  const pending = new Map<string, Set<string>>();
  for (const r of rows) {
    const d = String(r.date ?? "").replace(/-/g, "").slice(0, 8);
    const g = String(r.guid ?? "");
    if (!/^\d{8}$/.test(d) || !g) continue;
    if (!pending.has(d)) pending.set(d, new Set());
    pending.get(d)!.add(g);
  }
  return pending;
}

/**
 * Which days this run reads, oldest first: inside the current FY, strictly
 * before today (today's bills arrive with their buyer through the normal sync,
 * and today is when the operator is typing), not already done, at most `maxDays`.
 */
export function selectDays(
  pending: ReadonlyMap<string, unknown>,
  opts: { done: readonly string[]; fyStart: string; today: string; maxDays: number },
): string[] {
  const done = new Set(opts.done);
  return [...pending.keys()]
    .filter((d) => d >= opts.fyStart && d < opts.today && !done.has(d))
    .sort()
    .slice(0, Math.max(0, opts.maxDays));
}

export interface BackfillDeps {
  /** One day from Tally, parsed (tallyPost, non-raw). Throws on ANY Tally error. */
  fetchDay(day: string): Promise<any>;
  /** UPDATE the buyer_* columns of one mirror row; returns rows updated, or null for a dry run. `voucherNumber` is for logging. */
  writeBuyer(guid: string, patch: BuyerPatch, voucherNumber: string): Promise<number | null>;
  sleep(ms: number): Promise<void>;
  /** True when another sync holds Tally — the run yields and resumes later. */
  busy(): boolean;
  log(line: string): void;
}

export interface BackfillResult {
  /** Days read and written to completion, in order. */
  daysDone: string[];
  /** Set when a Tally error stopped the run — nothing after it was requested. */
  stopped: { day: string; error: string } | null;
  /** Set when the run yielded to another sync before finishing. */
  yielded: boolean;
  named: number;
  written: number;
  unmatched: number;
}

/**
 * Read `days` one at a time, writing each Cash voucher's buyer onto its mirror
 * row. Stops at the first fetch error; a write error is thrown (that is
 * Supabase, not Tally, and nothing about Tally's state is implied by it).
 */
export async function backfillDays(
  days: readonly string[],
  pending: ReadonlyMap<string, ReadonlySet<string>>,
  deps: BackfillDeps,
  opts: { pauseMs: number },
): Promise<BackfillResult> {
  const out: BackfillResult = { daysDone: [], stopped: null, yielded: false, named: 0, written: 0, unmatched: 0 };
  for (const [i, day] of days.entries()) {
    if (i > 0) await deps.sleep(opts.pauseMs);
    if (deps.busy()) { out.yielded = true; deps.log(`yielding before ${day} — another sync holds Tally`); break; }

    let parsed: any;
    try {
      parsed = await deps.fetchDay(day);
    } catch (e: any) {
      out.stopped = { day, error: String(e?.message ?? e) };
      deps.log(`STOP on ${day}: ${out.stopped.error} — no further requests; TallyPrime may need a restart`);
      break;
    }

    const want = pending.get(day) ?? new Set<string>();
    const all = convertVouchers(parsed).tallymessage;
    /* G7: the mirror holds Cash bills on this day, and Tally answered with no
       voucher at all. A company name Tally does not have open answers exactly
       like this (STATUS=1, a DATA node, zero objects, no error), so it is not
       "nothing to do" — the day is NOT marked done and the run stops. */
    if (all.length === 0 && want.size > 0) {
      out.stopped = { day, error: `Tally returned no vouchers for a day the mirror holds ${want.size} Cash bill(s) on — wrong or closed company?` };
      deps.log(`STOP on ${day}: ${out.stopped.error}`);
      break;
    }
    const cash = all.filter((v: any) => isCashLedger(v.partyledgername));
    let dayWritten = 0;
    for (const v of cash) {
      const guid = String(v.guid ?? "");
      const b = (v.buyer ?? {}) as Record<string, unknown>;
      if (b.buyer_name) out.named++;
      if (!want.has(guid)) { out.unmatched++; continue; }
      const patch = Object.fromEntries(BUYER_KEYS.map((k) => [k, (b[k] as string | null | undefined) ?? null])) as BuyerPatch;
      if (BUYER_KEYS.every((k) => patch[k] === null)) continue;   // nothing to say — leave the row alone
      const n = await deps.writeBuyer(guid, patch, String(v.vouchernumber ?? ""));
      if (n === null) continue;   // dry run
      if (n !== 1) deps.log(`${v.vouchernumber ?? guid}: updated ${n} rows (expected 1)`);
      dayWritten += n;
    }
    out.written += dayWritten;
    out.daysDone.push(day);
    deps.log(`${day}: ${cash.length} Cash voucher(s) from Tally, ${want.size} buyer-less in the mirror, ${dayWritten} written`);
  }
  return out;
}

// ── Persistence (local, like priceGstDailySync: must survive a restart) ──────

export interface BackfillState {
  /** YYYY-MM-DD (local) of the last run that finished or stopped. */
  lastRunDate: string | null;
  /** YYYYMMDD days already read — never re-requested. */
  done: string[];
  lastStop: { day: string; error: string; at: string } | null;
}

export const INITIAL_BACKFILL_STATE: BackfillState = { lastRunDate: null, done: [], lastStop: null };

let statePathOverride: string | null = null;
/** Test-only hook. */
export function configureBackfillStatePath(path: string | null): void { statePathOverride = path; }
const statePath = () => statePathOverride ?? join(process.cwd(), "server", "data", "cash-buyer-backfill-state.json");

export function loadBackfillState(): BackfillState {
  try {
    const raw = JSON.parse(readFileSync(statePath(), "utf8"));
    return {
      lastRunDate: typeof raw.lastRunDate === "string" ? raw.lastRunDate : null,
      done: Array.isArray(raw.done) ? raw.done.filter((d: unknown) => typeof d === "string") : [],
      lastStop: raw.lastStop && typeof raw.lastStop.day === "string" ? raw.lastStop : null,
    };
  } catch {
    return { ...INITIAL_BACKFILL_STATE, done: [] };
  }
}

export function saveBackfillState(s: BackfillState): void {
  try {
    mkdirSync(dirname(statePath()), { recursive: true });
    writeFileSync(statePath(), JSON.stringify(s), "utf8");
  } catch (e: any) {
    console.warn(`🧾 [CASH-BUYER] Could not persist state: ${e?.message ?? e}`);
  }
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const localDay = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/** Once per local day, at/after `hour`. A stopped run also counts — no retry until tomorrow. */
export function backfillDue(now: Date, state: BackfillState, hour: number): boolean {
  return state.lastRunDate !== localDay(now) && now.getHours() >= hour;
}

// ── The scheduler ───────────────────────────────────────────────────────────

let started = false;
let running = false;

export function startCashBuyerBackfill(tallyUrl: string, fallbackCompany: string): void {
  if (started) return;
  /* OPT-IN (1-Oct-2026): this job reads the OFFICE Tally on its own schedule,
     and the owner has not yet said when that machine may be read. It ships
     dormant; set CASH_BUYER_BACKFILL_ENABLED=true on the office machine once
     he has. */
  if ((process.env.CASH_BUYER_BACKFILL_ENABLED ?? "false").toLowerCase() !== "true") {
    console.log("🧾 [CASH-BUYER] Off (set CASH_BUYER_BACKFILL_ENABLED=true to enable)");
    return;
  }
  if (refuseSharedWrite("Cash-bill buyer backfill") || tallyRole() !== "primary") return;
  const sb = supabaseClient();
  if (!sb) { console.log("🧾 [CASH-BUYER] No Supabase client — backfill off"); return; }
  started = true;

  const hourRaw = parseInt(process.env.CASH_BUYER_BACKFILL_HOUR ?? "19", 10);
  const hour = Number.isFinite(hourRaw) ? Math.min(23, Math.max(0, hourRaw)) : 19;
  const maxRaw = parseInt(process.env.CASH_BUYER_BACKFILL_MAX_DAYS ?? "30", 10);
  const maxDays = Number.isFinite(maxRaw) && maxRaw > 0 ? maxRaw : 30;
  const PAUSE_MS = 3_000;      // keep the single-threaded port free between days
  const TIMEOUT_MS = 60_000;   // one day of header scalars answers in well under a second

  let state = loadBackfillState();
  console.log(`🧾 [CASH-BUYER] Scheduled once a day at/after ${pad2(hour)}:00, ≤${maxDays} day(s) per run ` +
    `(${state.done.length} day(s) already read${state.lastStop ? `; last stop ${state.lastStop.day}: ${state.lastStop.error}` : ""})`);

  const run = async (now: Date) => {
    const company = await resolveSyncCompany(fallbackCompany);
    const startedAt = new Date().toISOString();
    const t0 = Date.now();

    const probe = await sb.from("tally_vouchers").select("buyer_name").limit(1);
    if (probe.error) {
      console.warn(`🧾 [CASH-BUYER] tally_vouchers has no buyer_name (migration 043?) — skipping today: ${probe.error.message}`);
      state = { ...state, lastRunDate: localDay(now) };
      saveBackfillState(state);
      return;
    }

    const { data: rows, error } = await sb.from("tally_vouchers")
      .select("guid, date")
      .eq("company", company).ilike("party_ledger_name", "cash").ilike("voucher_type", "sales")
      .gte("date", `${fyStartYmd().slice(0, 4)}-04-01`).is("buyer_name", null)
      .limit(5000);
    if (error) { console.warn(`🧾 [CASH-BUYER] mirror read failed — will retry next tick: ${error.message}`); return; }

    const pending = groupPendingByDay(rows ?? []);
    const days = selectDays(pending, { done: state.done, fyStart: fyStartYmd(), today: todayYmd(), maxDays });
    if (days.length === 0) {
      state = { ...state, lastRunDate: localDay(now) };
      saveBackfillState(state);
      return;   // nothing pending — silent, it is the normal state once caught up
    }
    console.log(`🧾 [CASH-BUYER] ${rows?.length ?? 0} buyer-less Cash sale(s) over ${pending.size} day(s); reading ${days.length} day(s) for ${company}`);

    const result = await backfillDays(days, pending, {
      fetchDay: (day) => withTally(tallyUrl, `cash-buyer ${day}`, () => tallyPost(tallyUrl, cashBuyerDayRequest(company, day), TIMEOUT_MS)),
      writeBuyer: async (guid, patch) => {
        const { error: ue, count } = await sb.from("tally_vouchers")
          .update(patch, { count: "exact" }).eq("company", company).eq("guid", guid);
        if (ue) throw new Error(`mirror update ${guid}: ${ue.message}`);
        return count ?? 0;
      },
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      busy: isTallyBusy,
      log: (line) => console.log(`🧾 [CASH-BUYER]   ${line}`),
    }, { pauseMs: PAUSE_MS });

    state = {
      lastRunDate: result.yielded ? state.lastRunDate : localDay(now),
      done: [...new Set([...state.done, ...result.daysDone])].sort(),
      lastStop: result.stopped ? { ...result.stopped, at: new Date().toISOString() } : state.lastStop,
    };
    saveBackfillState(state);
    console.log(`🧾 [CASH-BUYER] ${result.daysDone.length} day(s) read, ${result.named} named buyer(s), ` +
      `${result.written} row(s) written${result.yielded ? " — yielded to a sync, resumes next tick" : ""}`);

    if (result.stopped) {
      const { error: he } = await sb.from("tally_sync_history").insert({
        company, sync_type: SYNC_TYPE, started_at: startedAt, completed_at: new Date().toISOString(),
        row_counts: { backfillDays: result.daysDone.length, buyersWritten: result.written },
        errors: [`Stopped on ${result.stopped.day}: ${result.stopped.error}`],
        success: false, duration_ms: Date.now() - t0,
      });
      if (he) console.error(`🧾 [CASH-BUYER] Failed to log the stop: ${he.message}`);
    }
  };

  const tick = () => {
    const now = new Date();
    if (running || !backfillDue(now, state, hour) || isTallyBusy()) return;
    running = true;
    run(now)
      .catch((e: any) => {
        // A Supabase write failure. Today is spent; Tally is not implicated.
        console.error(`🧾 [CASH-BUYER] ✗ ${e?.message ?? e}`);
        state = { ...state, lastRunDate: localDay(now) };
        saveBackfillState(state);
      })
      .finally(() => { running = false; });
  };
  setInterval(tick, 10 * 60_000);
}
