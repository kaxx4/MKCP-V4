/**
 * D-M.248 item 3 (runbook M11): the primary-safe proof of ONE real voucher. It POSTS NOTHING. It reads the voucher back from Tally by type,
 * date and number, and (with --job) reads the job and the counter from the database, then judges the seven checks of primaryTools.proofChecks.
 * fidelity-vs-native.ts cannot do this: it writes a marked voucher and deletes it, so it only runs on a sandbox.
 *
 *   npx tsx scripts/primary-voucher-proof.ts --job <job uuid> [--company "<name>"]
 *   npx tsx scripts/primary-voucher-proof.ts --payload-file job-payload.json --type Sales --date 2026-11-20 --number 2026-27/0001   (Tally half only)
 *   npx tsx scripts/primary-voucher-proof.ts --tally-only --type Sales --date 2026-11-20 --number ZZTEST1/1   (is it there exactly once)
 *
 * A check whose input could not be read is NOT RUN and counts as not passed: exit 0 only when all seven pass.
 * One request to Tally (the day, filtered by type and number). On the office PC the open company must carry MKCP_PRIMARY_COMPANY_GUID; on a
 * sandbox laptop the practice company's GUID stands in for the pin (the transport refuses any other company either way).
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { vouchersOnDateXml, diffStored } from "../src/services/safePush.js";
import { isSandbox, practiceCompany, practiceGuidProblem } from "../src/services/tallyRole.js";
import { primaryPinProblem, primaryCompanyName } from "../src/services/primaryMode.js";
import { tallyCompany } from "../src/config/company.js";
import { supabaseClient } from "../src/services/supabaseClient.js";
import { seriesCounter, SERIES_DEFAULTS } from "../src/services/voucherSeries.js";
import { financialYearOf } from "../src/services/remoteId.js";
import { proofChecks, type ProofInput } from "../src/services/primaryTools.js";
import type { VoucherPayload } from "../src/types.js";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };
const URL_ = process.env.TALLY_URL || "http://localhost:9000";
const sameType = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

(async () => {
  const sandbox = isSandbox();
  const company = arg("--company") ?? (sandbox ? practiceCompany() ?? "" : primaryCompanyName() || tallyCompany());
  if (!company) { console.error("No company: set MKCP_PRACTICE_COMPANY (sandbox) or MKCP_PRIMARY_COMPANY."); process.exit(2); }

  // Job side (database), if asked.
  let payload: (VoucherPayload & { companyKey?: string }) | null = null;
  let jobState: string | null = null, jobAttempts: number | null = null, jobsWithRemoteId: number | null = null, bookedNumber: string | null = null;
  let counterLast: number | null = null;
  const jobId = arg("--job");
  const payloadFile = arg("--payload-file");
  if (payloadFile) payload = JSON.parse(readFileSync(payloadFile, "utf8"));
  if (jobId) {
    const c = supabaseClient();
    if (!c) { console.error("CANNOT READ THE JOB: this machine has no database client. Use --payload-file for the Tally half only."); process.exit(2); }
    const { data, error } = await c.from("erp_jobs").select("id, payload, state, attempts, booked_number").eq("id", jobId).maybeSingle();
    if (error || !data) { console.error(`CANNOT READ THE JOB: ${error?.message ?? "no such job"}`); process.exit(2); }
    payload = data.payload; jobState = data.state; jobAttempts = data.attempts; bookedNumber = data.booked_number ?? null;
    const rid = (data.payload as any)?.remoteId;
    if (rid) {
      const r = await c.from("erp_jobs").select("id", { count: "exact", head: true }).eq("payload->>remoteId", rid);
      jobsWithRemoteId = r.error ? null : r.count ?? null;
    }
    const key = Object.keys(SERIES_DEFAULTS).find((k) => sameType(k, payload!.voucherType));
    if (key) {
      const fy = financialYearOf(payload!.date);
      const s = await c.from("erp_voucher_series").select("last_issued").eq("company_key", (payload as any).companyKey ?? "MKCP").eq("fy", fy).ilike("voucher_type", payload!.voucherType).maybeSingle();
      counterLast = s.error || !s.data ? null : Number(s.data.last_issued);
    }
  }

  const type = arg("--type") ?? payload?.voucherType;
  const date = arg("--date") ?? payload?.date;
  /* With a job, the voucher is looked up under the number it was BOOKED as (a renumbered voucher is in Tally under that number), else the number sent. */
  const number = arg("--number") ?? (jobId ? bookedNumber ?? payload?.voucherNumber : payload?.voucherNumber) ?? undefined;
  if (!type || !date || !number) { console.error("Need the voucher's --type, --date and --number (or a --job / --payload-file that carries them)."); process.exit(2); }

  // The pin, then ONE read.
  const listing = (await tallyPost(URL_, HEALTH_XML, 10_000, true)) as string;
  const pinWhy = sandbox ? practiceGuidProblem(company, listing) : primaryPinProblem(company, listing);
  if (pinWhy) console.log(`  PIN: ${pinWhy}`);
  const xml = pinWhy ? "" : ((await tallyPost(URL_, vouchersOnDateXml(company, date, { voucherType: type, voucherNumber: number }), 120_000, true)) as string);
  const blocks = [...xml.matchAll(/<VOUCHER\b[^>]*>[\s\S]*?<\/VOUCHER>/g)].map((m) => m[0])
    .filter((v) => sameType(/<VOUCHERTYPENAME>([^<]*)</.exec(v)?.[1] ?? "", type) && (/<VOUCHERNUMBER>([^<]*)</.exec(v)?.[1] ?? "") === number);

  const fy = financialYearOf(date);
  const key = Object.keys(SERIES_DEFAULTS).find((k) => sameType(k, type));
  const input: ProofInput = {
    found: blocks.length,
    differences: payload && blocks.length === 1 ? diffStored(payload, blocks[0]) : payload ? [] : ["no payload given: what was sent is unknown, so nothing can be compared (NOT RUN)"],
    jobState, jobAttempts, jobsWithRemoteId,
    bookedNumber: jobId ? bookedNumber : number, sentNumber: payload?.voucherNumber ?? null,
    counterLast, numberCounter: key ? seriesCounter(number, SERIES_DEFAULTS[key].template, fy) : null,
    pinned: !pinWhy,
  };
  const notRun = new Set<string>();
  if (!payload) notRun.add("what Tally stored equals what was sent (no difference)");
  if (!jobId) for (const n of ["the queue shows the job succeeded", "it was sent once", "the number booked is the number the counter gave", "the counter stands at this number (the next one is one above)"]) notRun.add(n);

  console.log(`\nM11 proof of ${type} ${number} dated ${date} in ${company} (read-only)\n`);
  let pass = true;
  for (const c of proofChecks(input)) {
    const skipped = notRun.has(c.name);
    const ok = c.ok && !skipped;
    if (!ok) pass = false;
    console.log(`  ${skipped ? "NOT RUN  " : ok ? "PASS     " : "FAIL     "} ${c.name}${c.detail && !ok ? `  (${c.detail})` : ""}`);
  }
  console.log(`\n  ${pass ? "PROVED: every check passed" : "NOT PROVED: a check failed or could not be run"}\n`);
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error(`FAILED: ${(e as Error).message}`); process.exit(2); });
