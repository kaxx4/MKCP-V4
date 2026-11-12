/**
 * JOB: the agent's list of Tally companies by financial year, and which one a job may be sent to (F17, D-12-6.1, D-M.187).
 *
 * Tally holds one company per financial year and the name changes every 1 April. Until 1 April 2027 the agent had one
 * company (this year's). From April, a March bill may go to LAST YEAR'S company until March's return is recorded as
 * filed (the web app's `lateMarch.ts` decides that and stamps the target on the job). The agent's half is here:
 *
 *   - it holds a list of {company, financial year, GUID} (a name alone is not an identity: the dummy shares the real
 *     books' name, and a restored copy keeps its name);
 *   - a job that names no target goes to the agent's own company, exactly as today;
 *   - a job that names a target must match one entry of the list by exact name AND GUID, and Tally must have that
 *     company loaded under exactly that GUID, or the job is refused before anything is sent.
 *
 * Where the target sits on a job: `payload.targetCompany` and `payload.targetGuid` (text). The web app stamps them at
 * enqueue (web half of F17); this module only reads them. A target that names the agent's own company with no GUID
 * is the same as no target.
 *
 * Configuration: `MKCP_COMPANY_YEARS`, a JSON array, or a file named by `MKCP_COMPANY_YEARS_FILE`:
 *   [{"company":"<exact Tally name>","fyStart":2026,"guid":"<Tally GUID>"}, ...]
 * Nothing in code names a real company. A bad list refuses to load (the agent then runs on its own company alone and
 * says so), because guessing which entry was meant is exactly the mistake this prevents.
 *
 * Pure apart from the two small readers at the bottom. No Tally here.
 */
import { readFileSync } from "node:fs";
import { companyGuidsFromListing } from "./tallyRole.js";

export interface CompanyYear { company: string; fyStart: number; guid: string }

/** Tally GUIDs: 8-4-4-4-12 hex groups, often followed by a counter. Same shape the web side accepts (`lateMarch.ts`). */
export const GUID_RE = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}(-[0-9a-f]{1,8})?$/i;

export interface ParsedList { list: CompanyYear[]; problems: string[] }

/** Read the list from text. Any problem makes the whole list unusable (`list` is empty), so a half-read list is never used. */
export function parseCompanyYears(text: string | undefined | null): ParsedList {
  const raw = String(text ?? "").trim();
  if (!raw) return { list: [], problems: [] };
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return { list: [], problems: ["the company list is not valid JSON"] }; }
  if (!Array.isArray(data)) return { list: [], problems: ["the company list must be a JSON array"] };
  const list: CompanyYear[] = [];
  const problems: string[] = [];
  data.forEach((e, i) => {
    const o = (e ?? {}) as Record<string, unknown>;
    const company = typeof o.company === "string" ? o.company.trim() : "";
    const fyStart = o.fyStart;
    const guid = typeof o.guid === "string" ? o.guid.trim() : "";
    const at = `entry ${i + 1}`;
    if (!company) problems.push(`${at}: no company name`);
    if (typeof fyStart !== "number" || !Number.isInteger(fyStart) || fyStart < 2000 || fyStart > 2100) problems.push(`${at}: fyStart must be the calendar year the financial year starts in, such as 2026`);
    if (!GUID_RE.test(guid)) problems.push(`${at}: the GUID does not look like a Tally GUID`);
    if (company && typeof fyStart === "number" && GUID_RE.test(guid)) list.push({ company, fyStart, guid });
  });
  const byName = new Map<string, Set<string>>();
  const byYear = new Map<number, Set<string>>();
  for (const e of list) {
    (byName.get(e.company) ?? byName.set(e.company, new Set()).get(e.company)!).add(e.guid.toLowerCase());
    (byYear.get(e.fyStart) ?? byYear.set(e.fyStart, new Set()).get(e.fyStart)!).add(`${e.company}\u0000${e.guid.toLowerCase()}`);
  }
  for (const [name, g] of byName) if (g.size > 1) problems.push(`the company "${name}" is listed with two different GUIDs`);
  for (const [fy, g] of byYear) if (g.size > 1) problems.push(`financial year ${fy} is listed for two different companies`);
  return problems.length ? { list: [], problems } : { list, problems };
}

export type Target = { ok: true; company: string; entry: CompanyYear | null; viaList: boolean } | { ok: false; reason: string };

/** What the web app stamped on a job, if anything. */
export function targetOf(payload: unknown): { company: string; guid: string } {
  const p = (payload ?? {}) as Record<string, unknown>;
  return { company: typeof p.targetCompany === "string" ? p.targetCompany.trim() : "", guid: typeof p.targetGuid === "string" ? p.targetGuid.trim() : "" };
}

/**
 * Which company a job goes to. `own` is the agent's own company (the default today).
 *  - no target: `own`.
 *  - target names `own` with no GUID: `own`. With a GUID: it must equal the list's GUID for `own` when `own` is listed.
 *  - any other target: exactly one list entry must carry that exact name and that GUID (letter case ignored for the GUID only).
 * Names are compared exactly after trimming, because Tally's names are exact: a near-miss is a different company.
 */
export function resolveTarget(list: readonly CompanyYear[], want: { company: string; guid: string }, own: string): Target {
  const ownName = own.trim();
  if (!want.company && !want.guid) return { ok: true, company: ownName, entry: list.find((e) => e.company === ownName) ?? null, viaList: false };
  if (!want.company) return { ok: false, reason: "The job names a GUID but no company. Not sent." };
  if (want.company === ownName && !want.guid) return { ok: true, company: ownName, entry: list.find((e) => e.company === ownName) ?? null, viaList: false };
  if (!want.guid) return { ok: false, reason: `The job is aimed at "${want.company}", which is not this agent's own company, and it names no GUID. A company other than the agent's own is only sent to by name AND GUID. Not sent.` };
  if (!GUID_RE.test(want.guid)) return { ok: false, reason: "The job's company GUID does not look like a Tally GUID. Not sent." };
  const named = list.filter((e) => e.company === want.company);
  if (named.length === 0) return { ok: false, reason: `"${want.company}" is not in this agent's list of companies by year, so it cannot be sent to. Not sent.` };
  const hit = named.find((e) => e.guid.toLowerCase() === want.guid.toLowerCase());
  if (!hit) return { ok: false, reason: `The GUID on the job is not the one recorded for "${want.company}". Not sent.` };
  return { ok: true, company: hit.company, entry: hit, viaList: true };
}

/**
 * Is the entry's company open in Tally under exactly that GUID? Reads nothing itself: it is given the company listing
 * Tally returned. Null when yes; the reason when not (not loaded, loaded under several GUIDs, or another GUID).
 */
export function loadedProblem(listingXml: string, entry: CompanyYear): string | null {
  const guids = companyGuidsFromListing(listingXml);
  const found = guids.get(entry.company) ?? [];
  if (found.length === 0) return `"${entry.company}" is not open in Tally, so nothing can be sent to it. Open it and send again.`;
  if (found.length > 1) return `"${entry.company}" is open in Tally more than once under different GUIDs, so it cannot be told apart. Nothing sent.`;
  if (found[0].toLowerCase() !== entry.guid.toLowerCase()) return `The company open in Tally under the name "${entry.company}" carries a different GUID from the one recorded. It may be another copy. Nothing sent.`;
  return null;
}

/** The list this machine is configured with. A bad list loads as empty, with its problems, never half. */
export function loadCompanyYears(env: NodeJS.ProcessEnv = process.env): ParsedList {
  const file = (env.MKCP_COMPANY_YEARS_FILE ?? "").trim();
  if (file) {
    try { return parseCompanyYears(readFileSync(file, "utf8")); } catch { return { list: [], problems: ["the company list file could not be read"] }; }
  }
  return parseCompanyYears(env.MKCP_COMPANY_YEARS);
}

/** The entry for last financial year, relative to `fyStartThisYear` (such as 2027 on 2 April 2027), or null. */
export function lastYearEntry(list: readonly CompanyYear[], fyStartThisYear: number): CompanyYear | null {
  return list.find((e) => e.fyStart === fyStartThisYear - 1) ?? null;
}
