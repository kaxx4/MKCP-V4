/**
 * The ONE place the company's Tally name is written down.
 *
 * Mirrors the web app's domain/company.ts (TALLY_COMPANY_NAME). The agent reads
 * process.env.TALLY_COMPANY first (so a duplicate or next-year company works
 * without a code change) and falls back to this default.
 *
 * scripts/test-company-literal-guard.ts fails if the literal reappears anywhere
 * else in src/ or scripts/, so a rename is a one-file change.
 */
export const DEFAULT_TALLY_COMPANY = "M.K.CYCLES (P) LTD. - (from 1-Apr-26)";

/** The company to talk to: an explicit override, else TALLY_COMPANY, else the default. */
export function tallyCompany(override?: string | null): string {
  return (override && String(override).trim()) || (process.env.TALLY_COMPANY || "").trim() || DEFAULT_TALLY_COMPANY;
}
