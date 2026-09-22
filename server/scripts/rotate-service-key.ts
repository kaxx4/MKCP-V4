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
 *
 * ── A target list is a claim, and this one was wrong ──────────────────────
 *
 * The first version reported `MKCP MOB2/web-dashboard/.env` as "holds the key"
 * on the strength of the VARIABLE NAME being present. Measured 22-Sep-2026: the
 * value there is 13 characters — a placeholder — and that repo's own
 * `.env.example` states the policy beside it, *"NEVER commit a real key — set
 * this in Vercel/Supabase env only"*. So `--apply` would have written a live
 * service-role key into a file that today holds a harmless stub, **increasing**
 * the number of places the secret exists. A rotation script doing the inverse
 * of its job is worth more caution than the rotation itself.
 *
 * `--list-targets` now reports what each file ACTUALLY holds — live key,
 * placeholder, variable absent, file absent — and fingerprints the live ones
 * (a non-reversible 8-hex tag, never the value) so you can see at a glance
 * whether the copies agree. They have silently disagreed before.
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
type Target = { file: string; vars: string[]; neverWrite?: string };
const TARGETS: Target[] = [
  { file: join(ROOT, "mkcycles-dashboard", "server", ".env"), vars: ["SUPABASE_SERVICE_KEY"] },
  {
    file: join(ROOT, "MKCP MOB2", "web-dashboard", ".env"),
    vars: ["SUPABASE_SERVICE_KEY", "SUPABASE_SERVICE_ROLE_KEY"],
    /* NOT a copy of the key, and it must not become one.
       This file's SUPABASE_SERVICE_KEY is a 13-character PLACEHOLDER — measured
       22-Sep-2026, and `web-dashboard/.env.example` states the policy on the
       same line: "NEVER commit a real key — set this in Vercel/Supabase env
       only." The web app's service-role writes happen in Vercel's serverless
       functions, which read Vercel's own environment; nothing local needs the
       real value, and `vercel dev` failing with "Invalid API key" is the
       intended consequence of that.

       The first version of this script listed the file as "holds the key"
       because it only checked that the VARIABLE NAME was present. On `--apply`
       it would have written a live service-role key into a file that today
       holds a harmless stub — a rotation script INCREASING the number of places
       the secret exists, which is the exact inverse of its job. */
    neverWrite: "holds a deliberate placeholder — the real key belongs in Vercel's env, not on disk",
  },
  ...(APPDATA ? [
    { file: join(APPDATA, "MK Cycles Dashboard", ".env"), vars: ["SUPABASE_SERVICE_KEY"] },
    { file: join(APPDATA, "mkcycles-dashboard-electron", ".env"), vars: ["SUPABASE_SERVICE_KEY"] },
  ] : []),
];

/** A real Supabase secret, as opposed to `your-service-role-key-here`. Both
 *  the legacy `service_role` JWT and the newer `sb_secret_*` form count. */
const looksLikeRealKey = (v: string) => /^eyJ[A-Za-z0-9_-]+\.eyJ/.test(v) || /^sb_secret_/.test(v);

/** A stable, NON-reversible 8-hex tag for a key, so two files can be compared
 *  without either value being shown. Copies that disagree is the failure the
 *  September role-flip hit — both userData `.env` files and `server/.env` have
 *  to move together, and nothing said when they did not. */
const fingerprint = (v: string) =>
  ([...v].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7)).toString(16).padStart(8, "0");

/** What a file currently holds, named honestly. */
function inspect(file: string, vars: string[]) {
  if (!existsSync(file)) return { state: "absent" as const };
  const text = readFileSync(file, "utf8");
  for (const v of vars) {
    const found = text.match(new RegExp(`^${v}=(.*)$`, "m"))?.[1]?.trim();
    if (found === undefined) continue;
    return looksLikeRealKey(found)
      ? { state: "live" as const, fp: fingerprint(found) }
      : { state: "placeholder" as const, len: found.length };
  }
  return { state: "no-var" as const };
}

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
    console.log(`  local files, and what each one ACTUALLY holds:
`);
    for (const t of TARGETS) {
      const i = inspect(t.file, t.vars);
      const label =
        i.state === "absent" ? "absent          "
        : i.state === "no-var" ? "present, no key "
        : i.state === "placeholder" ? `placeholder(${String(i.len).padStart(3)}) `
        : `LIVE KEY ${i.fp}`;
      const note = t.neverWrite ? `  ${D}— left alone: ${t.neverWrite}${X}` : "";
      console.log(`    ${label}  ${rel(t.file)}${note}`);
    }
    /* Do the live copies agree? A rotation that moves some of them is worse
       than one that moves none, because the disagreement is invisible — that is
       exactly how the September role-flip left two files saying different
       things with nothing on screen to say so. */
    const live = TARGETS.map((t) => inspect(t.file, t.vars))
      .filter((i): i is { state: "live"; fp: string } => i.state === "live");
    if (live.length) {
      const distinct = new Set(live.map((i) => i.fp));
      console.log(`
  ${live.length} live copy(ies), ${distinct.size} distinct key(s)`
        + (distinct.size > 1 ? `  ${R}— they DISAGREE${X}` : `  ${G}— all the same${X}`));
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
    /* A target whose current value is a deliberate stub is NOT rotated. Writing
       a live key here would add a copy of the secret to disk, not remove one. */
    if (t.neverWrite) { warn(`${rel(t.file)} — ${t.neverWrite}`); continue; }
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
  console.log(`        set for BOTH production and preview (it is today). This is the`);
  console.log(`        ONLY place the web side's key lives — web-dashboard/.env keeps a`);
  console.log(`        placeholder on purpose, so miss this and every /api/* write fails`);
  console.log(`        with "Invalid API key" while the browser's own reads keep working.`);
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
