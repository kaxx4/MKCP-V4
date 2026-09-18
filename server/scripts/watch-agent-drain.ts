/**
 * Start the REAL push agent and watch it drain a queue row on its own.
 *
 * ── What this proves that drain-one-queued does not ───────────────────────
 *
 * `drain-one-queued` pushes a row because I told it to. This starts
 * `startPushAgent` — the same loop the desktop app runs — and then does
 * nothing. If a voucher reaches Tally, it reached it automatically.
 *
 * That is the difference between "the path works" and "the path runs itself",
 * and the second one is what an operator actually experiences: press Save in
 * the browser, and the voucher appears in Tally without anybody touching this
 * machine.
 *
 * ── Safety ───────────────────────────────────────────────────────────────
 *
 * The agent claims whatever is pending, so this must only be run when the queue
 * holds nothing you are not willing to post. It REFUSES to start if any pending
 * row carries a number that is not marked as a test — the same prefix rule the
 * rest of the harness uses.
 *
 *   npx tsx server/scripts/watch-agent-drain.ts [seconds]
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: join(here, "..", ".env") });

import { createClient } from "@supabase/supabase-js";
import { startPushAgent, getPushAgentStatus } from "../src/services/pushAgent.js";
import type { VoucherPayload } from "../src/types.js";

const TALLY = process.env.TALLY_URL || "http://localhost:9000";
const COMPANY = process.env.TALLY_COMPANY || "";
const TEST_PREFIXES = ["MKCP-", "RPLY-", "VERIFY-", "SMOKE-", "DEMO-"];
const isTest = (n: string) => TEST_PREFIXES.some((p) => String(n ?? "").toUpperCase().startsWith(p));

async function main(): Promise<void> {
  const seconds = Number(process.argv[2] || 90);
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) { console.error("SUPABASE_URL / SUPABASE_SERVICE_KEY missing"); process.exit(2); }
  const db = createClient(url, key, { auth: { persistSession: false } });

  const { data: rows } = await db.from("push_queue").select("id,status,payload").eq("company", COMPANY);
  const pending = (rows ?? []).filter((r) => r.status === "pending");
  const real = pending.filter((r) => !isTest((r.payload as VoucherPayload)?.voucherNumber ?? ""));

  console.log(`\n  WATCH THE AGENT DRAIN\n  ` + "─".repeat(58));
  console.log(`  role=${process.env.MKCP_TALLY_ROLE}  filedThrough=${process.env.MKCP_FILED_THROUGH ?? "(unset)"}`);
  console.log(`  pending rows: ${pending.length}${real.length ? ` — ${real.length} NOT marked as tests` : ""}`);

  if (real.length) {
    console.error(`\n  REFUSED. ${real.length} pending row(s) carry real voucher numbers:`);
    for (const r of real) console.error(`    ${(r.payload as VoucherPayload).voucherNumber}`);
    console.error(`  Starting the agent would post them. Cancel or clear them first.\n`);
    process.exit(2);
  }

  startPushAgent({ tallyUrl: TALLY });
  await new Promise((r) => setTimeout(r, 1500));
  const s = getPushAgentStatus();
  console.log(`  agent enabled=${s.enabled}  id=${s.agentId}`);
  if (!s.enabled) {
    console.error("\n  The agent did not start. With PUSH_AGENT_ENABLED=true that means");
    console.error("  supabaseClient() returned null — check MKCP_TALLY_ROLE.\n");
    process.exit(1);
  }

  console.log(`\n  Watching for ${seconds}s. Queue a voucher from the web app now.\n`);
  const seen = new Set<string>();
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 3000));
    const { data } = await db.from("push_queue").select("id,status,payload,last_error").eq("company", COMPANY);
    for (const r of data ?? []) {
      const p = r.payload as VoucherPayload;
      const k = `${r.id}:${r.status}`;
      if (seen.has(k)) continue;
      seen.add(k);
      if (r.status === "pending") continue;   // its arrival, not a transition
      console.log(`  ${new Date().toLocaleTimeString()}  ${p.voucherType} ${p.voucherNumber} → ${r.status}` +
        (r.last_error ? `  (${String(r.last_error).slice(0, 80)})` : ""));
    }
  }
  console.log("\n  done watching.");
  process.exit(0);
}

main().catch((e) => { console.error("\n  failed:", e instanceof Error ? e.message : e); process.exit(1); });
