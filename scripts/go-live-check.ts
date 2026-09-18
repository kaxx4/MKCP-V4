/**
 * Is this machine actually going to work on Monday morning?
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * This project's characteristic failure is not a crash. It is a feature that
 * typechecks, looks right on screen, logs success, and does nothing — the push
 * queue that never enqueued a row, the price-list import that landed under a
 * phantom company key for months, the change detector that returned 0/0 forever.
 * Seven of them.
 *
 * The configuration has exactly the same failure mode, and one switch is worse
 * than all of them: `MKCP_TALLY_ROLE=sandbox` refuses PUSH-QUEUE DRAINING. With
 * it set, every voucher the web app queues sits there for ever while the screen
 * says "queued for Tally" and the agent logs nothing anyone is reading. A whole
 * day's invoices would be missing from the books and nothing would have failed.
 *
 * So this checks the things that decide whether work reaches Tally, and it says
 * plainly which ones would stop it. Run it before the office opens.
 *
 *   npx tsx scripts/go-live-check.ts
 *
 * Exit code 0 = ready. 1 = something would silently swallow the day's work.
 */
import { createClient } from "@supabase/supabase-js";
import { offlineReason } from "../server/src/services/supabaseClient.js";
import { isSandbox } from "../server/src/services/tallyRole.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: join(here, "..", "server", ".env") });

type Level = "ready" | "blocked" | "warn";

interface Check {
  name: string;
  level: Level;
  detail: string;
  /** What to actually do about it. */
  fix?: string;
}

const checks: Check[] = [];
const add = (name: string, level: Level, detail: string, fix?: string) =>
  checks.push({ name, level, detail, fix });

/* ── 1. The switch that silently swallows everything ──────────────────── */
function checkRole(): void {
  const raw = (process.env.MKCP_TALLY_ROLE ?? "").trim().toLowerCase();
  if (raw === "sandbox") {
    add(
      "Tally role",
      "blocked",
      "MKCP_TALLY_ROLE=sandbox — push-queue draining, scheduled syncs and the nightly sync are ALL refused.",
      "Set MKCP_TALLY_ROLE=primary in server/.env — but ONLY if this machine holds the real books. " +
        "If another machine is still syncing the same company name, fix that first: both write the same Supabase rows.",
    );
  } else {
    add("Tally role", "ready", `primary${raw ? "" : " (default)"} — this machine writes to the shared mirror.`);
  }
}

/* ── 1b. Filed-period protection ──────────────────────────────────────── */
/**
 * The one unset variable that lets a submitted GST return be changed.
 *
 * Without MKCP_FILED_THROUGH the push guard has no idea which periods are
 * closed, so an Alter dated inside a filed return passes with ZERO errors.
 * Measured 14-Sep-2026 against the live masters: an Alter of a SALES dated
 * 2026-07-15 was accepted outright unset, and refused by name once set to
 * 2026-08-31 (server/scripts/verify-filed-period-gate.ts).
 *
 * safePush does warn — on every single write — which is how it has gone
 * unnoticed. A warning that appears every time is not a warning.
 *
 * It is a BLOCKER rather than a caution: revising a filed GST return is a
 * regulatory event, and the whole point of go-live-check is to refuse to start
 * in a state where that can happen quietly.
 */
function checkFiledPeriod(): void {
  const raw = (process.env.MKCP_FILED_THROUGH ?? "").trim();
  if (!raw) {
    add(
      "Filed-period protection",
      "blocked",
      "MKCP_FILED_THROUGH is not set, so the push guard cannot tell which GST periods are closed. " +
        "An Alter dated inside a submitted return is accepted with no error at all — verified.",
      "Set MKCP_FILED_THROUGH in server/.env to the LAST DATE whose GST return has been filed " +
        "(e.g. MKCP_FILED_THROUGH=2026-08-31). Update it each time a return is filed.",
    );
    return;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    add("Filed-period protection", "blocked",
      `MKCP_FILED_THROUGH="${raw}" is not a YYYY-MM-DD date, so the comparison is meaningless.`,
      "Use a plain ISO date, e.g. 2026-08-31.");
    return;
  }
  /* A date far in the past protects nothing; one in the future refuses edits to
     periods nobody has filed yet. Both are worth saying out loud. */
  const filed = new Date(`${raw}T00:00:00`);
  const days = Math.floor((Date.now() - filed.getTime()) / 86_400_000);
  if (days < 0) {
    add("Filed-period protection", "caution",
      `MKCP_FILED_THROUGH=${raw} is in the FUTURE, so edits to periods that have not been filed will be refused.`,
      "Set it to the last date actually filed.");
  } else if (days > 75) {
    add("Filed-period protection", "caution",
      `MKCP_FILED_THROUGH=${raw} is ${days} days old — more than two filing cycles. Anything filed since is unprotected.`,
      "Update it to the most recently filed period.");
  } else {
    add("Filed-period protection", "ready", `Filed through ${raw} — Alters inside that period are refused.`);
  }
}

/* ── 2. Offline mode ──────────────────────────────────────────────────────
   Asks the SAME function the agent asks, rather than re-reading one env var.

   This checked `MKCP_OFFLINE` alone, and a sandbox machine is offline WITHOUT
   it — `isOffline()` is true whenever `MKCP_TALLY_ROLE=sandbox`, which is how
   `supabaseClient()` comes back null. So on this machine the check printed
   "Supabase connection: Online." while the running agent could not reach
   Supabase at all. The overall verdict was still right, because the role check
   above STOPs — but a green line asserting a capability the machine does not
   have is the worst kind of output from the one tool whose entire job is
   telling you whether work will actually reach Tally. */
function checkOffline(): void {
  const why = offlineReason();
  if (why) {
    add("Supabase connection", "blocked", `${why} — the agent will not talk to Supabase at all.`,
      why === "MKCP_OFFLINE=true"
        ? "Remove MKCP_OFFLINE from server/.env, or set it to false."
        : "Expected on a machine holding a COPY of the company. On the machine with the real books, set MKCP_TALLY_ROLE=primary.");
  } else {
    add("Supabase connection", "ready", "Online.");
  }
}

/* ── 3. The push agent itself ─────────────────────────────────────────── */
function checkPushAgent(): void {
  const raw = (process.env.PUSH_AGENT_ENABLED ?? "").trim().toLowerCase();
  if (raw === "false" || raw === "0") {
    add("Push agent", "blocked", "PUSH_AGENT_ENABLED=false — nothing queued will ever reach Tally.",
      "Set PUSH_AGENT_ENABLED=true in server/.env.");
  } else if (isSandbox()) {
    /* `pushAgent` calls `refuseSharedWrite` before it drains anything, so
       "Enabled" was true of the setting and false of the behaviour. */
    add("Push agent", "blocked", "Enabled by setting, but refused: MKCP_TALLY_ROLE=sandbox.",
      "Expected on a copy of the company. Nothing queued will reach Tally from this machine.");
  } else {
    add("Push agent", "ready", raw ? "Enabled." : "Enabled (default).");
  }
}

/* ── 4. Can we actually reach Tally, and is it the right company? ─────── */
async function checkTally(): Promise<void> {
  const url = process.env.TALLY_URL || "http://localhost:9000";
  const want = (process.env.TALLY_COMPANY ?? "").trim();

  const body =
    `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST>` +
    `<TYPE>Collection</TYPE><ID>MkGoLive</ID></HEADER><BODY><DESC><STATICVARIABLES>` +
    `<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES><TDL><TDLMESSAGE>` +
    `<COLLECTION NAME="MkGoLive" ISMODIFY="No"><TYPE>Company</TYPE><NATIVEMETHOD>NAME</NATIVEMETHOD>` +
    `</COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;

  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 10_000);
    const res = await fetch(url, { method: "POST", body, signal: ctl.signal });
    clearTimeout(t);
    const text = await res.text();

    const names = [...text.matchAll(/<NAME[^>]*>([^<]+)<\/NAME>/gi)].map((m) => m[1].trim());
    if (names.length === 0) {
      add("Tally", "blocked", `Reachable at ${url} but no open company was reported.`,
        "Open the company in TallyPrime.");
      return;
    }

    if (!want) {
      add("Tally", "warn", `Open: ${names.join(", ")}. TALLY_COMPANY is not set, so nothing verifies which one we write to.`,
        "Set TALLY_COMPANY in server/.env to the exact company name.");
      return;
    }

    if (names.some((n) => n.toLowerCase() === want.toLowerCase())) {
      add("Tally", "ready", `"${want}" is open at ${url}.`);
    } else {
      add("Tally", "blocked", `TALLY_COMPANY is "${want}" but Tally has open: ${names.join(", ")}.`,
        "Open the right company, or correct TALLY_COMPANY.");
    }
  } catch (err) {
    add("Tally", "blocked", `Cannot reach ${url} — ${err instanceof Error ? err.message : String(err)}`,
      "Start TallyPrime and make sure its XML server is on (F1 › Settings › Connectivity).");
  }
}

/* ── 5. Supabase, and whether anything is stuck in the queue ──────────── */
async function checkQueue(): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    add("Supabase", "blocked", "SUPABASE_URL / SUPABASE_SERVICE_KEY missing from server/.env.",
      "Restore them from the backup or the other machine's .env.");
    return;
  }

  try {
    const sb = createClient(url, key, { auth: { persistSession: false } });
    const { count, error } = await sb
      .from("push_queue")
      .select("*", { count: "exact", head: true })
      .in("status", ["pending", "queued"]);

    if (error) {
      add("Supabase", "blocked", `push_queue unreadable — ${error.message}`);
      return;
    }

    add("Supabase", "ready", "Reachable, push_queue readable.");

    if ((count ?? 0) > 0) {
      add("Queued work", "warn", `${count} voucher(s) waiting in push_queue.`,
        "If these are old, they will all push the moment the agent starts. Check them before going live.");
    } else {
      add("Queued work", "ready", "Nothing waiting.");
    }
  } catch (err) {
    add("Supabase", "blocked", err instanceof Error ? err.message : String(err));
  }
}

/* ── Report ───────────────────────────────────────────────────────────── */
const MARK: Record<Level, string> = { ready: "  ok  ", blocked: " STOP ", warn: " note " };

async function main(): Promise<void> {
  checkRole();
  checkFiledPeriod();
  checkOffline();
  checkPushAgent();
  await checkTally();
  await checkQueue();

  console.log("\n  MKCP go-live check\n  " + "─".repeat(58));
  for (const c of checks) {
    console.log(`  [${MARK[c.level]}] ${c.name.padEnd(20)} ${c.detail}`);
    if (c.fix) console.log(`${" ".repeat(31)}→ ${c.fix}`);
  }

  const blocked = checks.filter((c) => c.level === "blocked");
  const warned = checks.filter((c) => c.level === "warn");
  console.log("  " + "─".repeat(58));

  if (blocked.length) {
    console.log(`\n  NOT READY — ${blocked.length} thing(s) would stop work reaching Tally:`);
    for (const b of blocked) console.log(`    · ${b.name}: ${b.detail}`);
    console.log("\n  Nothing would look broken. The screen would say 'queued' and the");
    console.log("  vouchers would simply never arrive.\n");
    return exitWith(1);
  }

  console.log(`\n  READY${warned.length ? ` — with ${warned.length} thing(s) worth a look above` : ""}.\n`);
  exitWith(0);
}

/**
 * Exit with a code this script's caller can actually trust.
 *
 * A bare `process.exit()` here aborts on Windows with
 * `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` — Node tears down
 * while a socket left open by the Supabase client or the Tally probe is still
 * closing. The process then dies with 127 instead of the code we asked for.
 *
 * That is not cosmetic, because this script is a GATE. 127 is indistinguishable
 * from "command not found", so a caller checking the exit code cannot tell
 * "two things would stop work reaching Tally" from "the check never ran" — the
 * same G7 confusion as "Tally returned nothing" versus "my parser found
 * nothing", and here it fails in the dangerous direction: a crashed check looks
 * exactly like a failed one, so a genuinely broken harness reads as a normal
 * NOT READY and nobody investigates.
 *
 * Setting `exitCode` and unref-ing the timer lets Node leave on its own the
 * moment those handles finish closing; the timer is only a backstop for when
 * something is genuinely still holding the loop open. It is deliberately
 * generous — a shorter one fired while stdout was still draining into a pipe
 * and truncated the report it had just printed.
 */
function exitWith(code: number): void {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 3_000).unref();
}

main().catch((e) => {
  /* A thrown error is NOT the same as "not ready" — it means the check itself
     could not run, and a gate must be able to tell those apart. */
  console.error("\n  The check could not complete:\n", e);
  exitWith(2);
});
