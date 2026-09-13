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

/* ── 2. Offline mode ──────────────────────────────────────────────────── */
function checkOffline(): void {
  if ((process.env.MKCP_OFFLINE ?? "").trim().toLowerCase() === "true") {
    add("Supabase connection", "blocked", "MKCP_OFFLINE=true — the agent will not talk to Supabase at all.",
      "Remove MKCP_OFFLINE from server/.env, or set it to false.");
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
    process.exit(1);
  }

  console.log(`\n  READY${warned.length ? ` — with ${warned.length} thing(s) worth a look above` : ""}.\n`);
  // Explicit, because the Supabase client keeps a handle open and Node's
  // teardown trips a libuv assertion on Windows on the way out.
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
