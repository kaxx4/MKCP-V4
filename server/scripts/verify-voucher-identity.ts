/**
 * Voucher identity in the mirror: master_id, alter_id, remote_id.
 *
 * ── What Tally will and will not give back ────────────────────────────────
 *
 * Asked on 13-Sep-2026 for MASTERID, ALTERID, REMOTEID and GUID on four
 * vouchers, two of which this app had pushed hours earlier WITH an explicit
 * REMOTEID: **REMOTEID came back on 0 of 4.** Tally does not export the one it
 * was given.
 *
 * So the mirror can never LEARN our identity by reading. MASTERID and ALTERID
 * are readable and are stored here; remote_id is written when we push and
 * backfilled from push_queue, which this script also does.
 *
 * Why it matters: REMOTEID is the only handle Tally offers. Today an order's
 * editability is inferred from push_queue, so it is lost the moment the queue
 * is pruned — and ALTERID's absence is why incremental sync has never run.
 *
 *   npx tsx server/scripts/verify-voucher-identity.ts
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: join(here, "..", ".env") });

import { createClient } from "@supabase/supabase-js";
import { tallyPostWithRetry } from "../src/tally.js";
import { buildCollectionXml } from "../src/services/xmlBuilder.js";
import { convertVouchers } from "../src/converters/convert.js";
import { TRANSACTION_COLLECTIONS } from "../src/config/collections.js";
import { SupabaseSync } from "../src/services/supabaseSync.js";

const TALLY = process.env.TALLY_URL || "http://localhost:9000";
const COMPANY = process.env.TALLY_COMPANY || "";
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;

let fails = 0;
const ok = (what: string, cond: boolean, detail = "") => {
  if (cond) console.log(`  ok    ${what}`);
  else { fails++; console.log(`  FAIL  ${what}${detail ? " — " + detail : ""}`); }
};

async function main(): Promise<void> {
  console.log("\n  VOUCHER IDENTITY\n  " + "─".repeat(62));

  // One month, because a wider pull returns empty placeholder entry lists.
  const def = TRANSACTION_COLLECTIONS[0];
  const parsed = await tallyPostWithRetry(
    TALLY, buildCollectionXml(def, COMPANY, "20260901", "20260930"), def.timeout, false, 1,
  );
  const { tallymessage: vs } = convertVouchers(parsed) as { tallymessage: Record<string, unknown>[] };

  const withMaster = vs.filter((v) => !!v.masterid);
  const withAlter = vs.filter((v) => !!v.alterid);
  console.log(`\n  ${vs.length} vouchers converted`);
  console.log(`     master_id on ${withMaster.length}`);
  console.log(`     alter_id  on ${withAlter.length}`);

  ok("MASTERID survives the converter — it was never fetched before", withMaster.length > 0);
  ok("ALTERID survives — it was converted but never stored", withAlter.length > 0);

  if (!SB_URL || !SB_KEY) {
    console.log("\n  (No Supabase credentials — skipping the landing check.)");
    process.exit(fails === 0 ? 0 : 1);
  }

  console.log("\n  Syncing via SupabaseSync.syncVouchers…");
  await new SupabaseSync().syncVouchers(vs, COMPANY);

  const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

  const { count: mc } = await sb.from("tally_vouchers")
    .select("*", { count: "exact", head: true }).eq("company", COMPANY).not("master_id", "is", null);
  const { count: ac } = await sb.from("tally_vouchers")
    .select("*", { count: "exact", head: true }).eq("company", COMPANY).not("alter_id", "is", null);

  ok("master_id landed", (mc ?? 0) > 0, `${mc} rows`);
  ok("alter_id landed", (ac ?? 0) > 0, `${ac} rows`);
  console.log(`        master_id on ${mc} · alter_id on ${ac}`);

  /* ── Backfill remote_id from push_queue ──────────────────────────────────
     Everything this app has already pushed carries its remoteId in the queue's
     payload. Copy it onto the voucher so editability survives the queue being
     pruned — which is the whole reason for the column. */
  const { data: jobs } = await sb.from("push_queue")
    .select("payload, status").eq("company", COMPANY).eq("status", "succeeded").limit(2000);

  let backfilled = 0;
  for (const j of jobs ?? []) {
    const p = (j as { payload?: Record<string, unknown> }).payload;
    const remoteId = typeof p?.remoteId === "string" ? p.remoteId : null;
    const num = typeof p?.voucherNumber === "string" ? p.voucherNumber : null;
    if (!remoteId || !num) continue;
    const { error } = await sb.from("tally_vouchers")
      .update({ remote_id: remoteId }).eq("company", COMPANY).eq("voucher_number", num).is("remote_id", null);
    if (!error) backfilled++;
  }
  console.log(`\n  Backfilled remote_id from ${backfilled} succeeded push job(s).`);

  const { count: rc } = await sb.from("tally_vouchers")
    .select("*", { count: "exact", head: true }).eq("company", COMPANY).not("remote_id", "is", null);
  console.log(`        remote_id now on ${rc} voucher(s)`);

  const { data } = await sb.from("tally_vouchers")
    .select("voucher_number, voucher_type, master_id, alter_id, remote_id")
    .eq("company", COMPANY).not("master_id", "is", null)
    .order("alter_id", { ascending: false }).limit(5);
  console.log("");
  for (const d of data ?? []) {
    console.log(`     ${String(d.voucher_number).padEnd(18)} ${String(d.voucher_type).padEnd(16)} ` +
      `master=${String(d.master_id).padEnd(8)} alter=${String(d.alter_id).padEnd(8)} ` +
      `remote=${d.remote_id ?? "—"}`);
  }

  /* The watermark incremental sync needs. Its absence is why that mode has
     never been reachable — every caller passes "full". */
  const { data: top } = await sb.from("tally_vouchers")
    .select("alter_id").eq("company", COMPANY).not("alter_id", "is", null)
    .order("alter_id", { ascending: false }).limit(1);
  const watermark = top?.[0]?.alter_id ?? 0;
  ok("the mirror now carries an AlterID watermark", Number(watermark) > 0, `${watermark}`);
  console.log(`\n  Watermark: ${watermark} — incremental sync is now reachable.`);

  console.log("\n  " + "─".repeat(62));
  console.log(`  ${fails === 0 ? "Identity is in the mirror." : fails + " check(s) failed."}\n`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
