/**
 * The whole loop, once: insert a job, run it, read the snapshot back.
 *
 * Proves the seam this project keeps losing things at — a page to a table, an
 * agent to a queue. Cleans up after itself, because the BACKUP company shares
 * its name with production and a snapshot left behind would sit under the
 * production key carrying an old copy's figures.
 */
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import { ReportRunner } from "../../src/services/reportRunner.js";
import { company, U } from "./harness.js";

const env: Record<string, string> = {};
for (const line of fs.readFileSync(".env", "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2];
}
const KEY = process.env.SUPABASE_SERVICE_KEY || env.SUPABASE_SERVICE_KEY;

(async () => {
  if (!KEY) { console.log("  no service key on this machine — cannot test the Supabase half"); return; }
  const co = await company();
  const sb = createClient(env.SUPABASE_URL || env.VITE_SUPABASE_URL || "https://vmkytsytxlofjyeotmgb.supabase.co", KEY, { auth: { persistSession: false } });
  const REPORT = process.argv[2] || "bills-payable";

  const { data: job, error } = await sb.from("tally_report_jobs")
    .insert({ company: co, report: REPORT, requested_by: "fidelity-test" })
    .select("*").single();
  if (error) { console.log(`  insert failed: ${error.message}`); return; }
  console.log(`\n  job ${job.id}  status=${job.status}`);

  const runner = new ReportRunner(sb, U);
  await runner.drain();

  const { data: after } = await sb.from("tally_report_jobs").select("*").eq("id", job.id).single();
  console.log(`  after run: status=${after.status} rows=${after.row_count} elapsed=${after.elapsed_ms}ms${after.error ? ` error=${after.error}` : ""}`);

  const { data: snap } = await sb.from("tally_report_snapshots")
    .select("report, row_count, captured_at, rows").eq("company", co).eq("report", REPORT).maybeSingle();
  if (!snap) { console.log("  NO SNAPSHOT — the seam is broken"); }
  else {
    console.log(`  snapshot: ${snap.row_count} rows, captured ${snap.captured_at}`);
    const first = (snap.rows as any[])[0];
    console.log(`  first row: ${JSON.stringify(first).slice(0, 170)}`);
  }

  if (process.argv.includes("--keep")) { console.log("  --keep: snapshot left for UI checking"); return; }
  // clean up — see the header
  await sb.from("tally_report_snapshots").delete().eq("company", co).eq("report", REPORT);
  await sb.from("tally_report_jobs").delete().eq("id", job.id);
  console.log(`  cleaned up\n`);
})().catch(e => { console.error("ERR:", e.message); process.exit(1); });
