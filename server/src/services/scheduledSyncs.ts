/**
 * The recurring quick syncs, moved off the Electron window.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * These three schedules used to live in `src/hooks/useScheduledSyncs.ts` — a
 * React hook in the RENDERER. So they only ran while the Electron window was
 * open. Close the window (or leave the app minimised to tray, which is how it
 * is actually used) and the mirror silently stopped refreshing: no error, no
 * gap in any log, just data quietly going stale while the dashboard kept
 * serving it as current.
 *
 * Running them here means they follow the process, not the window.
 *
 * ── What this covers, and what it does NOT ────────────────────────────────
 *
 * A renderer quick sync is two phases, and only the first is reproduced here:
 *
 *   phase 1  pull the day book from Tally → the SERVER uploads those vouchers
 *            to Supabase itself. This is the half that keeps the books fresh,
 *            and it is entirely server-side already.
 *   phase 2  push masters and config to Supabase from the RENDERER's Zustand
 *            stores. Not reproducible here — the server does not have those
 *            stores — and largely moot: `index.ts` writes five collections and
 *            discards the rest as web-owned, and the stores behind several of
 *            them have no write callers at all.
 *
 * So this is not yet a full replacement for `useScheduledSyncs`, and the
 * renderer hook is deliberately left in place. Deleting it is a separate step
 * that needs phase 2 accounted for first — claiming the replacement early would
 * stop masters syncing in exactly the silent way this module exists to fix.
 *
 * ── Three windows ─────────────────────────────────────────────────────────
 *
 *   Today        every SCHEDULED_SYNC_TODAY_MINUTES   (default 30)
 *   Last 7 days  every SCHEDULED_SYNC_WEEK_MINUTES    (default off)
 *   This FY      every SCHEDULED_SYNC_FY_MINUTES      (default off)
 *
 * The intervals match what the renderer shipped with, so enabling this changes
 * the cadence for nobody. `0` disables one, as it always did. The FY window is
 * off by default because it is heavy — the nightly job already covers it.
 *
 * ⚠ THE WHOLE THING IS OFF UNLESS SCHEDULED_SYNC_ENABLED=true, and refuses
 * outright on a machine declared MKCP_TALLY_ROLE=sandbox. Two machines share
 * one Supabase mirror and a Tally duplicate carries the same company name as
 * the original, so a sync from the wrong machine overwrites real vouchers with
 * a copy's — and nothing downstream can tell. See tallyRole.ts.
 *
 * ── Collisions are already handled ────────────────────────────────────────
 *
 * Every sync goes through the same endpoint and the same global lock, and a
 * busy lock answers 409. That is not a failure: whichever sync holds the lock
 * is refreshing the same data. Tally's XML port is single-threaded, so this
 * matters more than it looks — two overlapping pulls do not merely duplicate
 * work, they contend for the port that everything else is also waiting on.
 */
import { createClient } from "@supabase/supabase-js";
import { postTallySync } from "./localSyncClient.js";
import { refuseSharedWrite } from "./tallyRole.js";

let started = false;

/**
 * Dates here are COMPACT — `YYYYMMDD`, no separators.
 *
 * `/api/tally/sync-daybook` validates the length and rejects anything else with
 * a 400, while `/api/tally/sync` takes the hyphenated form. Two sync routes,
 * two date formats; sending this route a `2026-09-12` fails every tick with a
 * 400 that looks exactly like a scheduler that is running fine.
 *
 * All local-time, never `toISOString()`: that is UTC, and IST is +5:30, so
 * every tick between midnight and 05:30 would sync the PREVIOUS day and leave
 * the actual today unmirrored until morning.
 */
const compact = (d: Date): string => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
};

/** Today, YYYYMMDD, local. */
export function todayYmd(): string {
  return compact(new Date());
}

/** `n` days ago, YYYYMMDD, local. */
export function daysAgoYmd(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return compact(d);
}

/** 1 April of the financial year today falls in, YYYYMMDD. */
export function fyStartYmd(): string {
  const d = new Date();
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return `${y}0401`;
}

/**
 * Which company to sync, resolved the way every other caller resolves it.
 *
 * Shared rather than copied: the nightly job, the refresh listener and this
 * scheduler must agree on the answer, and three inlined copies of a lookup are
 * three chances to drift onto different companies — which would show up as a
 * mirror that is fresh for one company and stale for another, with nothing
 * saying why.
 */
export async function resolveSyncCompany(fallback: string): Promise<string> {
  const url = process.env.SUPABASE_URL || "https://vmkytsytxlofjyeotmgb.supabase.co";
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!key) return fallback;
  try {
    const supabase = createClient(url, key);
    const { data, error } = await supabase
      .from("tally_companies")
      .select("name")
      .order("synced_at", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    if (!error && data?.name) return data.name as string;
  } catch {
    /* fall through — a fallback company is better than no sync at all */
  }
  return fallback;
}

/**
 * When a day-book sync last COMPLETED, per company — whoever ran it.
 *
 * The renderer's `useScheduledSyncs` is still live, so while the Electron window
 * is open there are two schedulers wanting the same pull. The global lock makes
 * that safe (the loser gets a 409 before touching Tally), but it does not make
 * it sensible: offset by half an interval the two do not collide at all, they
 * simply pull twice as often, and every pull contends for Tally's
 * single-threaded XML port with everything else waiting on it.
 *
 * So the two cooperate instead. Whoever syncs first marks the clock, and a tick
 * that finds the window already refreshed recently stands down. That works
 * without the renderer knowing this exists, and it keeps working when the
 * renderer is closed — which is the whole point.
 */
const lastDaybookSyncAt = new Map<string, number>();

/** Called by the sync-daybook route for EVERY caller, not just this scheduler. */
export function noteDaybookSync(company: string): void {
  if (company) lastDaybookSyncAt.set(company, Date.now());
}

/** Minutes since the last day-book sync for a company, or Infinity if never. */
export function minutesSinceDaybookSync(company: string): number {
  const at = lastDaybookSyncAt.get(company);
  return at === undefined ? Infinity : (Date.now() - at) / 60_000;
}

const minutes = (name: string, dflt: number): number => {
  const raw = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : dflt;
};

export interface ScheduledWindow {
  label: string;
  everyMinutes: number;
  from: () => string;
}

/** The three windows, as configured. Exported so a caller can report them. */
export function scheduledWindows(): ScheduledWindow[] {
  return [
    { label: "Today", everyMinutes: minutes("SCHEDULED_SYNC_TODAY_MINUTES", 30), from: todayYmd },
    { label: "Last 7 days", everyMinutes: minutes("SCHEDULED_SYNC_WEEK_MINUTES", 0), from: () => daysAgoYmd(6) },
    { label: "This FY", everyMinutes: minutes("SCHEDULED_SYNC_FY_MINUTES", 0), from: fyStartYmd },
  ];
}

/**
 * Run one window now. Exported so it can be exercised without waiting out an
 * interval, and so a caller can trigger a window on demand.
 *
 * Returns what happened, rather than throwing: a scheduled job that dies on its
 * first bad tick is worse than one that logs and comes back in thirty minutes.
 */
export async function runScheduledWindow(
  port: number,
  fallbackCompany: string,
  w: ScheduledWindow,
): Promise<"ok" | "busy" | "failed" | "skipped"> {
  const company = await resolveSyncCompany(fallbackCompany);

  /* Stand down if this window was already refreshed recently — by the renderer's
     own scheduler, by the nightly job, or by someone pressing Sync. Half the
     interval, so a genuinely due tick still fires while a duplicate does not. */
  if (refuseSharedWrite(`Scheduled sync "${w.label}"`)) return "skipped";

  const since = minutesSinceDaybookSync(company);
  if (since < w.everyMinutes / 2) {
    console.log(`⏱  [SCHEDULED] ⏭ ${w.label} skipped — synced ${since.toFixed(0)}m ago`);
    return "skipped";
  }

  const from = w.from();
  const to = todayYmd();
  try {
    /* The SAME route the renderer's quick sync has always called, with the same
       daily chunking — not `/api/tally/sync`, which runs a whole sync plan.
       `origin` tags every [SYNC] line this produces so a tick can be attributed
       to the scheduler rather than to someone pressing a button. */
    const resp = await postTallySync(
      port,
      {
        company, fromDate: from, toDate: to, chunkMode: "daily",
        origin: `scheduled-${w.label.toLowerCase().replace(/\s+/g, "-")}`,
      },
      "/api/tally/sync-daybook",
    );
    if (resp.status === 409) {
      console.log(`⏱  [SCHEDULED] ⏭ ${w.label} skipped — a sync already holds the lock`);
      return "busy";
    }
    if (!resp.ok) {
      console.error(`⏱  [SCHEDULED] ✗ ${w.label} failed — HTTP ${resp.status}`);
      return "failed";
    }
    const result = resp.json as { success?: boolean; error?: string; stats?: Record<string, unknown> } | undefined;
    if (result && result.success === false) {
      // Zero rows is the signature of Tally being closed. Said plainly, because
      // the alternative is a "successful" sync that mirrored nothing.
      console.error(`⏱  [SCHEDULED] ✗ ${w.label}: ${result.error || "no data — is Tally open?"}`);
      return "failed";
    }
    const s = result?.stats as { vouchers?: number; elapsedSeconds?: number } | undefined;
    console.log(`⏱  [SCHEDULED] ✓ ${w.label} (${from} → ${to})`
      + (s ? ` — ${s.vouchers ?? 0} vouchers in ${s.elapsedSeconds ?? "?"}s` : ""));
    return "ok";
  } catch (e) {
    console.error(`⏱  [SCHEDULED] ✗ ${w.label} failed — ${e instanceof Error ? e.message : String(e)}`);
    return "failed";
  }
}

/**
 * Start the schedules. Idempotent — a second call is ignored, so a reload
 * cannot end up with two sets of timers pulling Tally in parallel.
 */
export function startScheduledSyncs(port: number, fallbackCompany: string): void {
  if (started) return;
  /* A COPY OF THE COMPANY MUST NEVER SYNC. Two machines share one mirror and a
     Tally duplicate carries the same name as the original, so a sync from here
     would overwrite the real company's vouchers with a copy's — see tallyRole. */
  if (refuseSharedWrite("Scheduled syncs")) return;

  /* OPT-IN, not opt-out. This was default-on when written, which was wrong: the
     real machine already syncs through the renderer's own scheduler, so
     defaulting on adds nothing there while arming a duplicate machine to
     overwrite the mirror the moment someone starts the agent on it.
     Turning it on is a deliberate act on the machine that holds the books. */
  if ((process.env.SCHEDULED_SYNC_ENABLED ?? "false").toLowerCase() !== "true") {
    console.log("⏱  [SCHEDULED] Off. Set SCHEDULED_SYNC_ENABLED=true on the machine holding the real books.");
    return;
  }
  started = true;

  const windows = scheduledWindows();
  const on = windows.filter((w) => w.everyMinutes > 0);
  console.log(`⏱  [SCHEDULED] ${windows.map((w) => `${w.label}: ${w.everyMinutes || "off"}m`).join(" · ")}`);
  if (on.length === 0) {
    console.log("⏱  [SCHEDULED] Every window is off — nothing scheduled.");
    return;
  }

  for (const w of on) {
    setInterval(() => void runScheduledWindow(port, fallbackCompany, w), w.everyMinutes * 60_000)
      // Don't hold the process open for a timer; the HTTP server already does.
      .unref?.();
  }

  /* One "Today" pass shortly after boot, so a restart does not leave the mirror
     stale for a full interval. Delayed rather than immediate: Tally is often
     still opening its own company at this point, and a pull that arrives first
     just fails and logs noise. */
  setTimeout(() => {
    const today = on.find((w) => w.label === "Today");
    if (today) void runScheduledWindow(port, fallbackCompany, today);
  }, 30_000).unref?.();
}
