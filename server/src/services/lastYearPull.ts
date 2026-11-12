/**
 * JOB: the weekly READ-ONLY pull of last financial year's Tally company, while March's return is not recorded as filed (F17, D-12-6.1 "R4").
 *
 * After 1 April the app may send a March bill to last year's company (see `companyYears.ts`). The mirror must keep seeing that company,
 * or those bills never show. So until March's GSTR-3B is recorded as filed (the same mark that closes the window on the web side), the
 * agent reads last year's company once a week into the mirror, through the same checked sync as this year's (`runMirrorSync`, its
 * floors and per-day checks), keyed by that company's own key. Nothing is ever written to Tally by this module.
 *
 * Two parts:
 *   planLastYearPull  pure: is a pull due now, and why not when it is not.
 *   runLastYearPull   the read: proves last year's company is open under its recorded GUID, then runs the mirror sync on it.
 *
 * Window, in plain words:
 *   - the list has an entry for last financial year (`fyStart` = this year's start year minus one);
 *   - it is on or after 1 April of this year's start year and no later than the hard stop, 30 June (a window nobody closed
 *     must not read last year's books for ever);
 *   - March's GSTR-3B is NOT recorded as filed (`erp_agent_filed_through('gstr3b')` is before 31 March);
 *   - the last pull was a week or more ago, or there has been none.
 */
import { indiaDateOf } from "./voucherSeries.js";
import { lastYearEntry, loadedProblem, type CompanyYear } from "./companyYears.js";
import { runMirrorSync, tallyMirrorReads, type MirrorStore, type MirrorSyncReport } from "./erpMirrorSync.js";

/** The last day last year's company is read at all, whatever is or is not recorded: 30 June of the new financial year. */
export const LAST_YEAR_HARD_STOP = "06-30";
export const WEEK_MS = 7 * 24 * 3_600_000;

export interface PullPlan { due: boolean; why: string; entry: CompanyYear | null }

/** Calendar year a financial year starting 1 April contains the given Indian day in. */
export const fyStartOf = (day: string): number => { const [y, m] = day.split("-").map(Number); return m >= 4 ? y : y - 1; };

export function planLastYearPull(s: {
  now: Date;
  list: readonly CompanyYear[];
  /** The newest day recorded as filed for GSTR-3B (`erp_agent_filed_through('gstr3b')`), or null. */
  gstr3bFiledThrough: string | null;
  lastPullAt: Date | null;
}): PullPlan {
  const day = indiaDateOf(s.now);
  const fy = fyStartOf(day);
  const entry = lastYearEntry(s.list, fy);
  if (!entry) return { due: false, why: `no company is recorded for financial year ${fy - 1}`, entry: null };
  if (day < `${fy}-04-01`) return { due: false, why: "last year's company is still this year's", entry };
  if (day > `${fy}-${LAST_YEAR_HARD_STOP}`) return { due: false, why: `past the hard stop (${LAST_YEAR_HARD_STOP}); last year's company is no longer read`, entry };
  const marchEnd = `${fy}-03-31`;
  if (s.gstr3bFiledThrough && s.gstr3bFiledThrough >= marchEnd) return { due: false, why: "March's GSTR-3B is recorded as filed; the window is closed", entry };
  if (s.lastPullAt && s.now.getTime() - s.lastPullAt.getTime() < WEEK_MS) return { due: false, why: "pulled within the last week", entry };
  return { due: true, why: s.lastPullAt ? "a week or more since the last pull" : "never pulled", entry };
}

export interface LastYearPullResult {
  state: "pulled" | "skipped" | "failed";
  why: string;
  report: MirrorSyncReport | null;
}

/**
 * Read last year's company into the mirror. `listing` reads Tally's company list; `store` is the mirror store keyed by LAST
 * year's company key. Read-only on Tally: the checks are two reads (the list, then the sync's own reads). A company that is
 * not open, or open under another GUID, is skipped with the reason: never read, never an error that stops anything else.
 */
export async function runLastYearPull(o: {
  entry: CompanyYear;
  tallyUrl: string;
  listing: () => Promise<string>;
  store: MirrorStore;
  scope?: { from: string; to: string };
  log?: (line: string) => void;
}): Promise<LastYearPullResult> {
  let problem: string | null;
  try { problem = loadedProblem(await o.listing(), o.entry); }
  catch (e) { return { state: "failed", why: `Tally's company list could not be read (${(e as Error).message})`, report: null }; }
  if (problem) return { state: "skipped", why: problem, report: null };
  try {
    const report = await runMirrorSync({ store: o.store, tally: tallyMirrorReads(o.tallyUrl, o.entry.company), kind: "full", scope: o.scope, log: o.log });
    return { state: report.state === "swapped" ? "pulled" : report.state === "refused" ? "skipped" : "failed", why: report.error ?? report.state, report };
  } catch (e) {
    return { state: "failed", why: (e as Error).message.slice(0, 200), report: null };
  }
}
