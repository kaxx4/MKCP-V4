/**
 * Offline mode: this machine can drive Tally all day and never touch Supabase.
 *
 * PURE — it contacts neither. It checks the decision and the structure, because
 * the thing being prevented is "a duplicate company's data silently overwrites
 * the real books", and that is not something to demonstrate in order to test it.
 *
 * ── What this is for ──────────────────────────────────────────────────────
 *
 * The real books run on the owner's other computer and sync to the shared
 * Supabase project. THIS computer has Tally open on a DUPLICATE company. A Tally
 * duplicate carries the SAME NAME as the original, and every mirror table is
 * keyed on that name alone — so both machines write the same rows and nothing
 * downstream can tell them apart.
 *
 * So a full dummy session here — pulling vouchers, pushing them, altering and
 * cancelling them — has to be possible with Supabase switched off entirely.
 *
 * ── The structural half ───────────────────────────────────────────────────
 *
 * `createClient` used to be called in NINE modules. Guarding nine call sites
 * means remembering all nine, and the tenth whenever someone adds it — which is
 * not a guard, it is a habit. Everything now goes through `supabaseClient()`,
 * and the scan below FAILS if a direct call reappears anywhere in src/.
 *
 * That check is the important one. The others confirm the switch works; this
 * one confirms it cannot be bypassed by accident.
 *
 *   npx tsx scripts/test-offline-mode.ts
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import "dotenv/config";
import { isOffline, offlineReason, supabaseClient, requireSupabase } from "../src/services/supabaseClient.js";
import { tallyRole } from "../src/services/tallyRole.js";

let passed = 0, failed = 0;
const failures: string[] = [];
const ok = (label: string, cond: boolean, detail = "") => {
  if (cond) { passed++; console.log(`    \x1b[32m✓\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`); }
  else { failed++; failures.push(label); console.log(`    \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`); }
};
const H = (s: string) => console.log(`\n\x1b[1m── ${s} ${"─".repeat(Math.max(0, 56 - s.length))}\x1b[0m`);

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Every .ts file under src/, recursively. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out;
}

console.log(`\n\x1b[1mOffline mode\x1b[0m`);

H("ONE CHOKEPOINT, ENFORCED");
{
  const files = sourceFiles(join(process.cwd(), "src"));
  const strays = files.filter((f) =>
    !f.endsWith("supabaseClient.ts") && /\bcreateClient\s*\(/.test(readFileSync(f, "utf8")));
  ok("no module builds its own Supabase client", strays.length === 0,
    strays.length ? strays.map((f) => f.replace(process.cwd(), "")).join(", ")
      : `${files.length} files scanned`);
  ok("the chokepoint itself exists and is the only caller",
    files.some((f) => f.endsWith("supabaseClient.ts")));
}

H("THE SWITCH");
ok("MKCP_OFFLINE=true means offline",
  withEnv({ MKCP_OFFLINE: "true", MKCP_TALLY_ROLE: "primary" }, () => isOffline()));
ok("and names itself",
  withEnv({ MKCP_OFFLINE: "true", MKCP_TALLY_ROLE: "primary" }, () => offlineReason()) === "MKCP_OFFLINE=true");

/* A copy of the company is offline by definition. Keeping the two settings in
   step by hand is exactly the kind of thing that gets forgotten once. */
ok("a sandbox machine is offline WITHOUT setting MKCP_OFFLINE",
  withEnv({ MKCP_OFFLINE: undefined, MKCP_TALLY_ROLE: "sandbox" }, () => isOffline()));
ok("and says which setting did it",
  withEnv({ MKCP_OFFLINE: undefined, MKCP_TALLY_ROLE: "sandbox" }, () => offlineReason()) === "MKCP_TALLY_ROLE=sandbox");

ok("a primary machine with no override is ONLINE",
  withEnv({ MKCP_OFFLINE: undefined, MKCP_TALLY_ROLE: "primary" }, () => isOffline()) === false);
ok("and reports no reason to be offline",
  withEnv({ MKCP_OFFLINE: undefined, MKCP_TALLY_ROLE: "primary" }, () => offlineReason()) === null);

H("WHAT CALLERS GET");
ok("offline hands back NO client, even with a service key present",
  withEnv({ MKCP_OFFLINE: "true" }, () => supabaseClient()) === null);
/* Callers that would rather fail loudly than report nothing — a diagnostic
   that silently finds no problems is worse than one that refuses to run. */
{
  let threw = "";
  withEnv({ MKCP_OFFLINE: "true" }, () => {
    try { requireSupabase("Reconciliation"); } catch (e) { threw = (e as Error).message; }
  });
  ok("requireSupabase throws, naming the setting responsible",
    /MKCP_OFFLINE=true/.test(threw), threw.slice(0, 90));
}

H("THIS MACHINE, AS CONFIGURED");
ok("declares itself a sandbox", tallyRole() === "sandbox",
  `MKCP_TALLY_ROLE=${process.env.MKCP_TALLY_ROLE ?? "(unset)"}`);
ok("and is therefore offline", isOffline(), offlineReason() ?? "ONLINE");
ok("so nothing here can reach the shared mirror", supabaseClient() === null);

console.log(`\n\x1b[1m${passed} passed · ${failed} failed\x1b[0m`);
if (failed) console.log(`\nfailed:\n${failures.map((f) => `  · ${f}`).join("\n")}`);
console.log();
process.exit(failed ? 1 : 0);
