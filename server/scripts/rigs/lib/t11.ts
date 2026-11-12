/**
 * JOB: the shared safety checklist and bookkeeping for the T11 "tally coverage" rigs.
 *
 * File 05 section 0, as code, so no rig can forget a line:
 *   1. the role is sandbox            2. TALLY_URL is loopback
 *   3. the ONE company open in Tally is the dummy, by GUID (the dummy shares the real
 *      company's NAME, so the name proves nothing)
 *   4. fake data only: ZZ TEST names, ZZZ GSTINs, numbers `ZZTEST<digits>/...`
 *      (the sweep and the census match that spelling, testVoucherMatch.ts)
 *
 * It reads Tally once (the company list, 10 s) and writes nothing. A rig calls
 * `preflight()` first and stops if it throws.
 *
 * Never put a secret in here: the GUID is read from the environment by name and only
 * ever compared, never printed.
 */
import { HEALTH_XML, tallyPost } from "../../../src/tally.js";
import { companyGuidsFromListing, practiceCompany, practiceGuid, tallyRole } from "../../../src/services/tallyRole.js";

const LOOPBACK = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\/?$/i;

export interface Preflight {
  tallyUrl: string;
  company: string;
  /** How many companies Tally has loaded (must be 1). */
  loaded: number;
  /** Milliseconds the company list took: a first sign Tally is healthy. */
  listMs: number;
}

export const tallyUrl = (): string => (process.env.TALLY_URL || "http://localhost:9000").trim();

/** Throws (with a plain reason) unless every safety line holds. Writes nothing. */
export async function preflight(): Promise<Preflight> {
  if (tallyRole() !== "sandbox") throw new Error("preflight: MKCP_TALLY_ROLE is not sandbox. Stopped; nothing was sent.");
  const url = tallyUrl();
  if (!LOOPBACK.test(url)) throw new Error(`preflight: TALLY_URL is not loopback (${url}). Stopped; nothing was sent.`);
  const company = practiceCompany();
  const want = practiceGuid();
  if (!company) throw new Error("preflight: MKCP_PRACTICE_COMPANY is not set. Stopped.");
  if (!want) throw new Error("preflight: MKCP_PRACTICE_COMPANY_GUID is not set. Stopped.");
  const t0 = Date.now();
  const xml = (await tallyPost(url, HEALTH_XML, 10_000, true)) as string;
  const listMs = Date.now() - t0;
  const guids = companyGuidsFromListing(xml);
  const all = [...guids.values()].flat();
  if (all.length !== 1) throw new Error(`preflight: ${all.length} company/companies are loaded in Tally; exactly one (the dummy) must be. Stopped; nothing was written.`);
  if (all[0] !== want) throw new Error("preflight: the company open in Tally does NOT carry the dummy's GUID. It may be the real books. Stopped; nothing was written.");
  const named = [...guids.keys()][0];
  if (named.trim().toLowerCase() !== company.trim().toLowerCase()) throw new Error("preflight: the open company's name differs from MKCP_PRACTICE_COMPANY. Stopped.");
  return { tallyUrl: url, company, loaded: all.length, listMs };
}

/** `ZZTEST<digits>`: digits only, so the sweep and the census see every voucher a rig makes. */
export const newStamp = (): string => Date.now().toString().slice(-6);

/** One step line, kept for the report. */
export interface RigStep { step: string; ok: boolean; detail: string; at: string }

export function stepRecorder(): { steps: RigStep[]; step: (s: string, ok: boolean, detail?: string) => void; passed: () => number; failed: () => number } {
  const steps: RigStep[] = [];
  return {
    steps,
    step(s, ok, detail = "") {
      steps.push({ step: s, ok, detail, at: new Date().toISOString() });
      console.log(`  ${ok ? "PASS" : "FAIL"}  ${s}${detail ? `  (${detail})` : ""}`);
    },
    passed: () => steps.filter((x) => x.ok).length,
    failed: () => steps.filter((x) => !x.ok).length,
  };
}
