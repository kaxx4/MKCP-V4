/**
 * Incremental sync: does it resume from where the mirror actually is?
 *
 * ── The failure being closed ──────────────────────────────────────────────
 *
 * RealtimeSync seeded its cursor from Tally's CURRENT AlterID at startup, so
 * every restart declared "everything up to now has been seen". A voucher
 * edited while the agent was down sits above the old cursor and below the new
 * one and is never re-read — no error, no log, a permanently wrong mirror.
 *
 * Migration 029 put alter_id on tally_vouchers, so the resume point can now be
 * derived from what the mirror HOLDS rather than from what Tally has reached.
 *
 * This checks the decision logic against every case, then reports the real
 * numbers from the live mirror and the live Tally — including how far behind
 * the mirror currently is, which is the number that says whether incremental
 * sync would actually have work to do.
 *
 *   npx tsx server/scripts/verify-incremental-cursor.ts
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: join(here, "..", ".env") });

import { createClient } from "@supabase/supabase-js";
import { ChangeDetector } from "../src/services/changeDetector.js";
import { mirrorVoucherWatermark, resolveVoucherCursor } from "../src/services/syncCursor.js";

const TALLY = process.env.TALLY_URL || "http://localhost:9000";
const COMPANY = process.env.TALLY_COMPANY || "";
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;

let fails = 0;
const ok = (what: string, cond: boolean, detail = "") => {
  if (cond) console.log(`  ok    ${what}${detail ? "  — " + detail : ""}`);
  else { fails++; console.log(`  FAIL  ${what}${detail ? "  — " + detail : ""}`); }
};

async function main(): Promise<void> {
  console.log("\n  INCREMENTAL SYNC — the resume point\n  " + "─".repeat(66));

  // ── The decision logic, every branch ────────────────────────────────────
  console.log("\n  1. resolveVoucherCursor — each case named");

  const behind = resolveVoucherCursor(355528, 355600);
  ok("a mirror behind Tally resumes from the MIRROR", behind.source === "mirror" && behind.value === 355528,
    `${behind.value} (Tally at 355600)`);
  ok("and says how many AlterIDs it will pick up", behind.note.includes("72"),
    "the number that used to be lost on every restart");

  const level = resolveVoucherCursor(355528, 355528);
  ok("a mirror level with Tally resumes from the same point", level.source === "mirror" && level.value === 355528);

  const fresh = resolveVoucherCursor(null, 355600);
  ok("an empty mirror falls back to Tally's mark", fresh.source === "tally-now" && fresh.value === 355600);
  ok("and SAYS edits before now will not be re-read", fresh.note.includes("will NOT be re-read"),
    "the degraded case is announced, not assumed");

  const nothing = resolveVoucherCursor(null, 0);
  ok("nothing anywhere starts from zero", nothing.source === "zero" && nothing.value === 0);

  /* Null and 0 are DIFFERENT instructions — "I do not know" against "start from
     the beginning" — and conflating them is how a cursor silently becomes a
     full skip. The guarantee lives at the SOURCE: mirrorVoucherWatermark
     returns null rather than 0, so the two can never arrive here as the same
     value. Asserting that resolveVoucherCursor(0) behaves like null would be
     asserting the wrong contract — 0 legitimately means "start from the
     beginning", and it is unreachable from the real caller. */
  ok("a null watermark falls back rather than sweeping from zero",
    resolveVoucherCursor(null, 100).value === 100);

  // ── The live numbers ────────────────────────────────────────────────────
  console.log("\n  2. Where things actually stand");

  if (!SB_URL || !SB_KEY) {
    console.log("     (No Supabase credentials — cannot read the mirror.)");
    process.exit(fails === 0 ? 0 : 1);
  }

  const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });
  const fromMirror = await mirrorVoucherWatermark(sb, COMPANY);

  const detector = new ChangeDetector();
  const tallyNow = await detector.fetchCurrentAlterIds(TALLY, COMPANY);

  const origin = resolveVoucherCursor(fromMirror, tallyNow.transactionId);

  console.log(`\n     mirror watermark : ${fromMirror ?? "(none — no alter_id in the mirror)"}`);
  console.log(`     Tally now        : ${tallyNow.transactionId}`);
  console.log(`     resume from      : ${origin.value}  (source: ${origin.source})`);
  console.log(`     ${origin.note}`);

  ok("the mirror can answer where to resume", fromMirror !== null,
    fromMirror === null ? "run a full sync to populate alter_id" : `watermark ${fromMirror}`);
  ok("the resume point is durable across a restart", origin.source === "mirror",
    origin.source === "mirror" ? "a restart no longer skips edits made while down" : `source is ${origin.source}`);

  /* The count above the cursor is the real test: it is exactly the work a
     restart used to throw away. */
  if (fromMirror !== null) {
    const gap = tallyNow.transactionId - fromMirror;
    console.log(`\n     ${gap} AlterID(s) above the mirror's watermark.`);
    if (gap > 0) {
      console.log(`     Before this change a restart would have set the cursor to ` +
        `${tallyNow.transactionId} and never looked at them.`);
    } else {
      console.log(`     The mirror is level with Tally, so there is nothing to pick up right now.`);
    }
  }

  /* ── What the watermark does NOT prove (P7) ─────────────────────────────
     A watermark is the max over rows that HAVE an alter_id, and only vouchers
     synced since migration 029 have one. If the mirror holds 2,792 vouchers
     and Tally holds 3,336, "level with Tally" describes forward progress and
     says nothing about the backlog underneath. Both numbers, so the claim
     cannot be read as more than it is. */
  const { count: mirrorTotal } = await sb.from("tally_vouchers")
    .select("*", { count: "exact", head: true }).eq("company", COMPANY);
  const { count: mirrorWithAlter } = await sb.from("tally_vouchers")
    .select("*", { count: "exact", head: true }).eq("company", COMPANY).not("alter_id", "is", null);

  console.log(`\n     COVERAGE — what the watermark does not say:`);
  console.log(`       vouchers in Tally             : ${tallyNow.transactionId ? "see AlterID sweep above" : "?"}`);
  console.log(`       vouchers in the mirror        : ${mirrorTotal}`);
  console.log(`       …of which carry an alter_id   : ${mirrorWithAlter}`);
  console.log(`     The watermark is the max over those ${mirrorWithAlter} rows. It is the right`);
  console.log(`     resume point for what happens NEXT, and it is not evidence that the`);
  console.log(`     ${(mirrorTotal ?? 0) - (mirrorWithAlter ?? 0)} rows without one are current. A full sync populates them.`);

  const enabled = (process.env.REALTIME_SYNC_ENABLED ?? "").trim() === "true";
  console.log(`\n     REALTIME_SYNC_ENABLED: ${enabled ? "true — the loop runs on boot" : "not set — the loop is off"}`);
  if (!enabled) {
    console.log(`     The cursor is correct now, but nothing drives it until this is set.`);
    console.log(`     POST /api/realtime/start turns it on for a running agent without a restart.`);
  }

  console.log("\n  " + "─".repeat(66));
  console.log(`  ${fails === 0 ? "The resume point comes from the mirror." : fails + " check(s) failed."}\n`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
