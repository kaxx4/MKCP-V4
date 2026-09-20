/**
 * Apply a rotated Supabase service-role key everywhere this machine holds it.
 *
 * ── What you do, and what this does ───────────────────────────────────────
 *
 * YOU, in the Supabase dashboard:
 *   Project Settings → API → Project API keys → `service_role` → Rotate.
 *
 * THEN, here:
 *   set NEW_SUPABASE_SERVICE_KEY and run this. It rewrites every local file
 *   that holds the key, backs each one up first, verifies the new key actually
 *   works against Supabase, and prints what is left for you to do by hand.
 *
 *   NEW_SUPABASE_SERVICE_KEY=<the new key> npx tsx server/scripts/rotate-service-key.ts
 *   NEW_SUPABASE_SERVICE_KEY=<the new key> npx tsx server/scripts/rotate-service-key.ts --apply
 *
 * Without `--apply` it reports what it WOULD change and verifies the key; with
 * `--apply` it writes.
 *
 * ── It never prints the key ───────────────────────────────────────────────
 *
 * Not in output, not in the backups it names, not in an error path. Files are
 * reported by name and by whether the line changed, never by value — because
 * the whole point of a rotation is that the old value stops being interesting
 * and the new one never becomes interesting.
 *
 * ── Why the stale backups matter ──────────────────────────────────────────
 *
 * Found 20-Sep-2026: `server/.env.bak-before-golive-20260914` and
 * `server/.env.bak-role-flip-20260915-114650` each carry the CURRENT key. A
 * rotation that updates `.env` and leaves those behind has not reduced the
 * exposure at all — it has just made the live copy the odd one out. This
 * offers to shred them, and says so loudly if you decline.
 */
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync, copyFileSync, unlinkSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");           // …/Live-Sync
const APPLY = process.argv.includes("--apply");
const SHRED = process.argv.includes("--shred-backups");
const NEW = process.env.NEW_SUPABASE_SERVICE_KEY?.trim();

const G = "\x1b[32m", Y = "\x1b[33m", R = "\x1b[31m", D = "\x1b[2m", X = "\x1b[0m";
const ok = (s: string) => console.log(`  ${G}✓${X} ${s}`);
const warn = (s: string) => console.log(`  ${Y}!${X} ${s}`);
const bad = (s: string) => console.log(`  ${R}✗${X} ${s}`);

/**
 * Every local file that holds the key, and the variable it holds it under.
 *
 * The userData copies are NOT optional and were nearly missed. The desktop app
 * reads `<userData>/.env` in preference to the bundled copy, while the server
 * does `import "dotenv/config"` against the repo file — two processes, two
 * files, and BOTH have to move together. Flipping this machine to `sandbox` in
 * September needed both; changing one alone did nothing visible and left the
 * two disagreeing.
 *
 * There are two userData directories because the app's productName changed:
 * `mkcycles-dashboard-electron` is the old Electron default and
 * `MK Cycles Dashboard` the current one. Both still exist here and both hold
 * the key, so both are rewritten — otherwise the stale one quietly becomes a
 * copy of a credential nobody remembers rotating.
 */
const APPDATA = process.env.APPDATA ?? "";
const TARGETS: { file: string; vars: string[] }[] = [
  { file: join(ROOT, "mkcycles-dashboard", "server", ".env"), vars: ["SUPABASE_SERVICE_KEY"] },
  { file: join(ROOT, "MKCP MOB2", "web-dashboard", ".env"), vars: ["SUPABASE_SERVICE_KEY", "SUPABASE_SERVICE_ROLE_KEY"] },
  ...(APPDATA ? [
    { file: join(APPDATA, "MK Cycles Dashboard", ".env"), vars: ["SUPABASE_SERVICE_KEY"] },
    { file: join(APPDATA, "mkcycles-dashboard-electron", ".env"), vars: ["SUPABASE_SERVICE_KEY"] },
  ] : []),
];

/** Stale copies — same secret, no longer serving any purpose. */
const STALE = [
  join(ROOT, "mkcycles-dashboard", "server", ".env.bak-before-golive-20260914"),
  join(ROOT, "mkcycles-dashboard", "server", ".env.bak-role-flip-20260915-114650"),
];

/** Repo files print relative to the workspace; userData is outside it, so an
 *  ugly ../../.. would obscure exactly the paths most easily overlooked. */
const rel = (p: string) => {
  const r = relative(ROOT, p).replace(/\\/g, "/");
  return r.startsWith("..") ? p.replace(/\\/g, "/") : r;
};

/** Replace `VAR=…` in place, preserving every other line and the file's order. */
function rewrite(text: string, vars: string[], value: string): { text: string; changed: string[] } {
  const changed: string[] = [];
  const out = text.split(/\r?\n/).map((line) => {
    const m = line.match(/^([A-Z0-9_]+)\s*=/);
    if (!m || !vars.includes(m[1])) return line;
    changed.push(m[1]);
    return `${m[1]}=${value}`;
  }).join("\n");
  return { text: out, changed };
}

/** Does the new key actually work? One authenticated REST call, no data read. */
async function verify(url: string, key: string): Promise<{ ok: boolean; status: number; note: string }> {
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/rest/v1/`, {
      method: "GET",
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    return {
      ok: res.status < 400,
      status: res.status,
      note: res.status === 401 ? "rejected — wrong or not yet active"
        : res.status < 400 ? "accepted"
        : `unexpected ${res.status}`,
    };
  } catch (e) {
    return { ok: false, status: 0, note: `could not reach Supabase: ${(e as Error).message.slice(0, 60)}` };
  }
}

(async () => {
  console.log(`\n  ROTATE THE SUPABASE SERVICE-ROLE KEY\n  ${"─".repeat(66)}`);

  /* `--list-targets` needs no key, so the list of files this will rewrite can
     be checked BEFORE the rotation rather than discovered during it. Without
     it every other path is gated behind a valid key, which means the target
     list is the one part of this script nobody can verify until the moment it
     matters. Prints names and existence only — never a value. */
  if (process.argv.includes("--list-targets")) {
    console.log(`  files this would rewrite:
`);
    for (const t of TARGETS) {
      const here = existsSync(t.file);
      const has = here && t.vars.some((v) => new RegExp(`^${v}=`, "m").test(readFileSync(t.file, "utf8")));
      console.log(`    ${here ? (has ? "holds the key " : "present, no key") : "absent        "}  ${rel(t.file)}`);
    }
    console.log(`
  stale copies of the old key:
`);
    const st = STALE.filter(existsSync);
    if (!st.length) console.log(`    none`);
    for (const f of st) console.log(`    holds the key   ${rel(f)}`);
    console.log();
    return;
  }

  if (!NEW) {
    bad("NEW_SUPABASE_SERVICE_KEY is not set.");
    console.log(`\n  Rotate it first:  Supabase dashboard → Project Settings → API`);
    console.log(`                    → Project API keys → service_role → Rotate\n`);
    console.log(`  Then:  ${D}NEW_SUPABASE_SERVICE_KEY=<new key> npx tsx server/scripts/rotate-service-key.ts${X}\n`);
    process.exit(2);
  }
  if (!/^eyJ[A-Za-z0-9_-]+\.eyJ/.test(NEW)) {
    bad("That does not look like a Supabase key (expected a JWT starting `eyJ`). Stopping.");
    process.exit(2);
  }

  /* Verify BEFORE writing. Rotating and then discovering the key is wrong
     leaves every consumer broken at once, and the agent would be offline with
     no obvious cause. */
  const url = (readFileSync(TARGETS[0].file, "utf8").match(/^SUPABASE_URL=(.+)$/m)?.[1] ?? "").trim();
  if (!url) { bad(`No SUPABASE_URL in ${rel(TARGETS[0].file)} — cannot verify.`); process.exit(2); }
  const v = await verify(url, NEW);
  (v.ok ? ok : bad)(`new key against Supabase: ${v.note}`);
  /* `process.exitCode` and RETURN, not `process.exit()`. Calling exit() here
     tore down the loop while the verify() fetch handle was still closing, and
     Windows raised `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` —
     after the verdict had printed, so it read as cosmetic. It is not: on that
     path the exit code is whatever the abort leaves behind, and a script whose
     own pass/fail cannot be trusted is the exact thing this week was about. */
  if (!v.ok) { console.log(`\n  Not writing anything. Fix the key first.\n`); process.exitCode = 1; return; }

  console.log(`\n  ── local files`);
  for (const t of TARGETS) {
    if (!existsSync(t.file)) { warn(`${rel(t.file)} — not present, skipped`); continue; }
    const text = readFileSync(t.file, "utf8");
    const { text: next, changed } = rewrite(text, t.vars, NEW);
    if (!changed.length) { warn(`${rel(t.file)} — holds none of ${t.vars.join("/")}`); continue; }
    if (!APPLY) { console.log(`     would update ${rel(t.file)} → ${changed.join(", ")}`); continue; }
    const backup = `${t.file}.pre-rotate-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`;
    copyFileSync(t.file, backup);
    writeFileSync(t.file, next);
    ok(`${rel(t.file)} → ${changed.join(", ")}   ${D}(backup ${rel(backup)})${X}`);
  }

  console.log(`\n  ── stale copies of the OLD key`);
  const present = STALE.filter(existsSync);
  if (!present.length) ok("none on disk");
  for (const f of present) {
    if (SHRED && APPLY) { unlinkSync(f); ok(`deleted ${rel(f)}`); }
    else warn(`${rel(f)} still holds the old key — pass --shred-backups to delete`);
  }

  console.log(`\n  ── NOT done by this script, and nothing can do them from here`);
  console.log(`     1. Vercel · project mkcpweb · SUPABASE_SERVICE_KEY`);
  console.log(`        set for BOTH production and preview (it is today).`);
  console.log(`        ${D}vercel env rm SUPABASE_SERVICE_KEY production && vercel env add SUPABASE_SERVICE_KEY production${X}`);
  console.log(`     2. The OFFICE machine's userData .env — the two on THIS machine
        are handled above, but the office box has its own. The app provisions`);
  console.log(`        this on first run, so either re-provision it (MKCP_EMBED_ENV=1`);
  console.log(`        build, carried by hand — never published) or edit the file in`);
  console.log(`        place and restart the agent.`);
  console.log(`     3. Confirm the agent reconnected: its status panel should show the`);
  console.log(`        push queue claiming jobs again, not "push agent disabled".`);

  if (!APPLY) console.log(`\n  ${Y}Dry run — nothing written. Re-run with --apply.${X}`);
  console.log();
})();
