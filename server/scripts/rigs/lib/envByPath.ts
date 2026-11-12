/**
 * JOB: let a test rig take the ERP test-queue identity from another worktree's `.env` BY PATH, itself, so no one
 * copies a value by hand or in a shell script (coordinator ruling D-M.180, 12-Nov-2026).
 *
 *   npx tsx scripts/rigs/erp-queue-dummy.ts --env-file <path to an .env>
 *
 * Import this file FIRST (right after `dotenv/config`). It reads the file, takes ONLY the two names below, sets
 * them in this process (children inherit them) unless they are already set, and turns on the test-queue switch for
 * this one process. It prints which names it set, never a value, and refuses a path that is not an `.env` file.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { parse } from "dotenv";

export const ENV_NAMES = ["MKCP_AGENT_MACHINE_ID", "MKCP_ERP_AGENT_KEY"] as const;

/** Pure: which of the named settings the file text carries (by name; values stay in the returned map only). */
export function pickNamed(text: string): Record<string, string> {
  const all = parse(text);
  const out: Record<string, string> = {};
  for (const n of ENV_NAMES) { const v = (all[n] ?? "").trim(); if (v) out[n] = v; }
  return out;
}

const i = process.argv.indexOf("--env-file");
if (i >= 0) {
  const path = process.argv[i + 1] ?? "";
  if (!/(^|[\/])\.env(\.[A-Za-z0-9_-]+)?$/.test(path) || /\.(ts|js|json)$/i.test(basename(path))) {
    console.error("--env-file must name an .env file."); process.exit(2);
  }
  let picked: Record<string, string> = {};
  try { picked = pickNamed(readFileSync(path, "utf8")); } catch { console.error("--env-file: that file could not be read."); process.exit(2); }
  const set: string[] = [], had: string[] = [], missing: string[] = [];
  for (const n of ENV_NAMES) {
    if (process.env[n]) { had.push(n); continue; }
    if (picked[n]) { process.env[n] = picked[n]; set.push(n); } else missing.push(n);
  }
  process.env.MKCP_ERP_TEST_QUEUE = "on";
  console.log(`  env-file: set ${set.join(", ") || "nothing"}; already in the environment: ${had.join(", ") || "nothing"}; not found: ${missing.join(", ") || "nothing"}; test-queue switch on for this process only`);
  if (missing.length) { console.error("--env-file: a required setting is missing, so the queue rig cannot run."); process.exit(2); }
}
