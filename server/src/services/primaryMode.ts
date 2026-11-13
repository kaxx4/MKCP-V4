/**
 * JOB: the office PC's "single primary" mode (go-live dry run D-M.248, runbook D4, M1, M2). One place that says
 * whether this process is the one agent that works the live queue and keeps the live mirror, and which Tally company it may write to.
 *
 * OFF BY DEFAULT. Nothing here changes a machine until MKCP_PRIMARY_MODE=on is set on it. A machine that does not set it (today's office
 * agent, every sandbox) behaves exactly as before.
 *
 * The settings (all in the agent's own environment, never in the repo):
 *   MKCP_PRIMARY_MODE=on            this process is the single primary: queue loop and mirror loop (see primaryRunner.ts)
 *   MKCP_PRIMARY_COMPANY_GUID=...   the GUID of the one Tally company the primary may write to. FAIL CLOSED: with the mode on and this unset,
 *                                   nothing is posted and nothing is claimed.
 *   MKCP_PRIMARY_COMPANY=...        the company's name as Tally shows it (else the agent's usual company setting)
 *   MKCP_PRIMARY_COMPANY_KEY=...    the stable company key the mirror and the voucher counters use (else the name without its "(from ...)" part)
 *   MKCP_AGENT_MACHINE_ID, MKCP_ERP_AGENT_KEY   this machine's registration on the ERP queue (see scripts/primary-register.ts)
 *
 * Why a GUID and not the name: a copy of the company shares the real company's name (tallyRole.ts), and last year's company is a different
 * company with a similar name. The GUID is the identity. The practice-company check of the sandbox works the same way, from the other side.
 */
import { companyGuidsFromListing } from "./tallyRole.js";

type Env = Record<string, string | undefined>;

/** Is the single-primary mode switched on for this process? */
export const primaryModeOn = (env: Env = process.env): boolean => (env.MKCP_PRIMARY_MODE ?? "").trim().toLowerCase() === "on";

/** The GUID the primary's company must carry ("" when unset). */
export const primaryGuid = (env: Env = process.env): string => (env.MKCP_PRIMARY_COMPANY_GUID ?? "").trim();

/** The company name the primary works on, or "" when neither setting names one. */
export function primaryCompanyName(env: Env = process.env): string {
  return (env.MKCP_PRIMARY_COMPANY ?? env.MKCP_COMPANY ?? env.TALLY_COMPANY ?? "").trim();
}

/** "Name - (from 1-Apr-26)" becomes "Name": the key the mirror and the counters use, the same for every year's company. */
export function stableCompanyKey(name: string): string {
  return String(name ?? "").replace(/\s*-?\s*\(from [^)]*\)\s*$/i, "").trim();
}
export function primaryCompanyKey(env: Env = process.env): string {
  const k = (env.MKCP_PRIMARY_COMPANY_KEY ?? "").trim();
  return k || stableCompanyKey(primaryCompanyName(env));
}

/** Does this request write to Tally (an Import)? Reads, the company listing and the health check are not writes. */
export function isImportRequest(xml: string): boolean {
  return /<TALLYREQUEST>\s*Import/i.test(xml);
}

/**
 * Pure: why the single-primary mode cannot run on this machine as configured, or null. It never talks to Tally.
 * The mode is for the real books only: a machine that declares itself a sandbox may not run it, whatever else is set.
 */
export function primaryModeRefusal(env: Env = process.env): string | null {
  if ((env.MKCP_TALLY_ROLE ?? "").trim().toLowerCase() === "sandbox") {
    return "refused: the single-primary mode does not run on a sandbox machine (MKCP_TALLY_ROLE=sandbox). Sandbox machines work only ZZ TEST jobs on the practice company.";
  }
  if (!primaryGuid(env)) {
    return "refused: MKCP_PRIMARY_COMPANY_GUID is not set, so this machine cannot prove which company it holds. Nothing is posted and nothing is claimed until it is set.";
  }
  return null;
}

/**
 * Pure: the pin. Given the company listing Tally returned (HEALTH_XML) and the company this machine means to work on, null when that company
 * is open under exactly one GUID and it is the pinned one; else the reason, in plain words. Fails closed on every doubt: the GUID unset,
 * the company not open, open more than once under different GUIDs, or open under another GUID (the real books against a copy, or one year
 * against another).
 */
export function primaryPinProblem(company: string, listingXml: string, env: Env = process.env): string | null {
  const why = primaryModeRefusal(env);
  if (why) return why;
  const named = String(company ?? "").trim();
  if (!named) return "refused: no company is named, so the pinned company cannot be checked. Nothing was sent to Tally.";
  const guids = companyGuidsFromListing(listingXml);
  const key = [...guids.keys()].find((k) => k.toLowerCase() === named.toLowerCase());
  const found = key === undefined ? [] : guids.get(key) ?? [];
  if (found.length === 0) return `refused: company "${named}" is not open in Tally, so its GUID cannot be checked. Nothing was sent to Tally.`;
  if (found.length > 1) return `refused: company "${named}" is open more than once under different GUIDs, so the pinned company cannot be told apart. Nothing was sent to Tally.`;
  if (found[0].trim().toLowerCase() !== primaryGuid(env).toLowerCase()) {
    return `refused: company "${named}" is open under a GUID other than MKCP_PRIMARY_COMPANY_GUID. It is a copy or another year's books. Nothing was sent to Tally.`;
  }
  return null;
}
