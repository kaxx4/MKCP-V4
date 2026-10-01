/**
 * CASH-P1 backfill — give the Cash SALES vouchers already in the mirror their
 * real buyer. WRITTEN 30-Sep-2026 AND NEVER RUN. Work through the checklist
 * below before the first run.
 *
 * CASH-P2, 1-Oct-2026: the running agent now does this by itself, once a day on
 * a primary machine (server/src/services/cashBuyerBackfill.ts, which this script
 * imports — one copy of the logic). This script stays as the by-hand path: a
 * single --day dry run is still the cheapest way to see what the agent will write.
 *
 * ── VERIFICATION CHECKLIST (owner has Tally open) ─────────────────────────
 * 0. Migration 043 applied (SELECT buyer_name FROM tally_vouchers LIMIT 1 works).
 *    Tally open on the right company, no dialog showing, nothing else syncing.
 * 1. ONE voucher first: Cash sale 26-27/0654, 5-Sep-2026 — already captured
 *    from live Tally on 23-Sep (data/native-shape/26_27_0654.explicit.xml), so
 *    the answer is known in advance. Dry run, one request, header only:
 *      npx tsx server/scripts/backfill-cash-buyers.ts --day 20260905
 *    Expect: the day's Cash vouchers listed; 0654's buyer = the PARTYMAILINGNAME
 *    in that capture (not "Cash"), place = its ADDRESS line, pincode "-".
 *    Then look at Tally: no error dialog, and it still answers (open any report).
 *    If a dialog appeared: STOP, restart Tally, report what it said.
 * 2. Open two other invoices from that dry run in Tally and compare the Party
 *    Details screen: buyer name and address must match what the script printed.
 * 3. Write just that day:  --day 20260905 --write
 *    Expect "N written" = the Cash count; in Supabase those rows now have
 *    buyer_name set and every other column unchanged (alter_id, synced_at).
 * 4. Then the rest, a few days at a time:  --write --max-days 5
 *    Re-run until "0 day(s)". Any STOP line → restart Tally, then re-run
 *    (it resumes). Finally:
 *      SELECT count(*) FILTER (WHERE buyer_name IS NOT NULL), count(*)
 *      FROM tally_vouchers WHERE party_ledger_name='Cash' AND date>='2026-04-01';
 *    Expect ~97% named (census: 401 of 412 Cash sales carry a mailing name);
 *    the rest are walk-ins with no name and correctly stay NULL.
 * 5. After the next normal sync, a NEW Cash bill lands with buyer_* filled
 *    without this script (the fetch-list change), and the agent log shows
 *    "[convert] Cash buyers: N named, M addressed (of K Cash vouchers)".
 *
 * ── Why a backfill is needed at all ───────────────────────────────────────
 * The new fetch fields only reach vouchers the sync re-pulls, and syncVouchers
 * SKIPS re-upserting any voucher whose AlterID did not move
 * (changeSummary.unchangedGuids). The ~253 Cash bills already mirrored have not
 * moved, so a normal sync would re-read them and still never write the buyer.
 *
 * ── What it does, and nothing else ────────────────────────────────────────
 * 1. Reads from the MIRROR the distinct dates of SALES vouchers on ledger
 *    "Cash" with buyer_name IS NULL (FY26-27 onward).
 * 2. For ONE day at a time: one Voucher collection request filtered to that
 *    single date, HEADER scalars only — no entry blocks (those are 64x the
 *    payload, and a wide pull with them has wedged Tally). Awaited to the end
 *    before anything else is sent.
 * 3. Converts with the production converter (convertVouchers →
 *    extractVoucherBuyer), keeps the Cash vouchers, and UPDATEs only the six
 *    buyer_* columns on the mirror row with the same company + GUID. It never
 *    inserts, never deletes, never touches any other column.
 * 4. Records the day as done in data/backfill-cash-buyers.progress.json, waits,
 *    then does the next day.
 *
 * ANY Tally error stops the run at once (tally-error-requires-restart: after an
 * error TallyPrime's port is dead until a human restarts it — retrying only
 * hides that). Re-running resumes from the progress file.
 *
 * DRY RUN BY DEFAULT: pulls and prints what it would write. `--write` writes.
 *
 *   npx tsx server/scripts/backfill-cash-buyers.ts --day 20260905          # one day, dry
 *   npx tsx server/scripts/backfill-cash-buyers.ts --day 20260905 --write  # one day, write
 *   npx tsx server/scripts/backfill-cash-buyers.ts --write [--max-days 5]  # the rest, resumable
 *
 * Needs: MKCP_TALLY_ROLE=primary (a sandbox machine gets no Supabase client —
 * by design; the sandbox Tally is an old copy sharing production's name),
 * TALLY_COMPANY set explicitly, and migration 043 applied.
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { config } from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: join(here, "..", ".env") });

import { tallyPost } from "../src/tally.js";
import { requireSupabase } from "../src/services/supabaseClient.js";
import { todayYmd } from "../src/services/scheduledSyncs.js";
// CASH-P2: the logic lives in server/src so the running agent does the same
// thing on its own (G1). This script is the by-hand path over the same code.
import {
  cashBuyerDayRequest, groupPendingByDay, selectDays, backfillDays,
} from "../src/services/cashBuyerBackfill.js";

const TALLY = process.env.TALLY_URL || "http://localhost:9000";
const COMPANY = process.env.TALLY_COMPANY || "";
const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const WRITE = args.includes("--write");
const ONLY_DAY = arg("--day");
const MAX_DAYS = Number(arg("--max-days") ?? "0") || Infinity;
const PAUSE_MS = 3_000;           // keep the single-threaded port free between days
const TIMEOUT_MS = 60_000;        // one day of header scalars answers in well under a second
const FY_START = "2026-04-01";
const PROGRESS = join(here, "..", "data", "backfill-cash-buyers.progress.json");

async function main(): Promise<void> {
  if (!COMPANY) throw new Error("TALLY_COMPANY must be set explicitly — the mirror is keyed on it.");
  if (ONLY_DAY && !/^\d{8}$/.test(ONLY_DAY)) throw new Error("--day takes YYYYMMDD");
  const sb = requireSupabase("backfill-cash-buyers");

  // Migration 043 present? A missing column fails here, before Tally is touched.
  const probe = await sb.from("tally_vouchers").select("buyer_name").limit(1);
  if (probe.error) throw new Error(`migration 043 not applied? ${probe.error.message}`);

  const done: string[] = existsSync(PROGRESS) ? JSON.parse(readFileSync(PROGRESS, "utf8")).done ?? [] : [];

  // The work list comes from the MIRROR, not from Tally: fewer requests, and
  // exactly the rows that need it.
  const { data: rows, error } = await sb.from("tally_vouchers")
    .select("guid, date")
    .eq("company", COMPANY).ilike("party_ledger_name", "cash").ilike("voucher_type", "sales")
    .gte("date", FY_START).is("buyer_name", null)
    .limit(5000);
  if (error) throw new Error(`mirror read failed: ${error.message}`);
  const pending = groupPendingByDay(rows ?? []);
  const days = ONLY_DAY
    ? (pending.has(ONLY_DAY) ? [ONLY_DAY] : [])
    : selectDays(pending, { done, fyStart: FY_START.replace(/-/g, ""), today: todayYmd(), maxDays: MAX_DAYS });

  console.log(`\n  ${rows?.length ?? 0} Cash sales without a buyer over ${pending.size} days; ` +
    `this run: ${days.length} day(s), ${WRITE ? "WRITING" : "DRY RUN"}\n`);

  const result = await backfillDays(days, pending, {
    fetchDay: (day) => tallyPost(TALLY, cashBuyerDayRequest(COMPANY, day), TIMEOUT_MS),
    writeBuyer: async (guid, patch, number) => {
      console.log(`    ${WRITE ? "→" : "·"}  ${number}  ${patch.buyer_name ?? "(no buyer)"} | ${patch.buyer_place ?? "-"} | ${patch.buyer_pincode ?? "-"}`);
      if (!WRITE) return null;
      const { error: ue, count } = await sb.from("tally_vouchers")
        .update(patch, { count: "exact" }).eq("company", COMPANY).eq("guid", guid);
      if (ue) throw new Error(`update ${number}: ${ue.message}`);
      return count ?? 0;
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    busy: () => false,
    log: (line) => console.log(`  ${line}`),
  }, { pauseMs: PAUSE_MS });

  if (WRITE && !ONLY_DAY && result.daysDone.length) {
    writeFileSync(PROGRESS, JSON.stringify({ done: [...new Set([...done, ...result.daysDone])].sort() }, null, 1));
  }
  console.log(`\n  done: ${result.named} named buyers read, ${result.written} rows written, ${result.unmatched} unmatched\n`);
  if (result.stopped) {
    console.error(`  STOP on ${result.stopped.day}: ${result.stopped.error}`);
    console.error("  Assume TallyPrime is now frozen. Have it RESTARTED before re-running; progress is saved.");
    process.exit(3);
  }
}

main().catch((e) => { console.error("ERR:", e?.message ?? e); process.exit(1); });
