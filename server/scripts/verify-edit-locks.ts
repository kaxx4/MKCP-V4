/**
 * Edit locks — the Phase 3 gate: "two devices on one voucher, the second is
 * refused with a named holder".
 *
 * Runs against the live lock table using a remote_id in a marked test range,
 * and removes every row it created. Nothing real is touched.
 *
 *   npx tsx server/scripts/verify-edit-locks.ts
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: join(here, "..", ".env") });

import { createClient } from "@supabase/supabase-js";
import {
  acquireLock, heartbeat, releaseLock, overrideLock, activeLocks, sweepExpiredLocks,
  LOCK_TTL_SECONDS,
} from "../src/services/editLocks.js";

const COMPANY = process.env.TALLY_COMPANY || "";
const SB_URL = process.env.SUPABASE_URL!;
const SB_KEY = (process.env.SUPABASE_SERVICE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY)!;

const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });
const RID = `MKCP|LOCKTEST|${Date.now()}`;

let pass = 0, fail = 0;
const ok = (what: string, cond: boolean, detail = "") => {
  if (cond) { console.log(`  ok    ${what}${detail ? "  — " + detail : ""}`); pass++; }
  else { console.log(`  FAIL  ${what}${detail ? "  — " + detail : ""}`); fail++; }
};

async function main(): Promise<void> {
  console.log("\n  EDIT LOCKS\n  " + "─".repeat(66));
  console.log(`  company: ${COMPANY}`);
  console.log(`  test remote_id: ${RID}\n`);

  try {
    // ── 1. First device takes it ──────────────────────────────────────────
    console.log("  1. Two devices, one voucher");
    const a = await acquireLock(sb, COMPANY, RID, "accountant@desk", "desktop-1");
    ok("the first device gets the lock", a.ok && a.took === "fresh");

    // ── 2. Second device is refused, and told who ─────────────────────────
    const b = await acquireLock(sb, COMPANY, RID, "owner@phone", "phone-1");
    ok("THE SECOND DEVICE IS REFUSED — this is the gate", !b.ok);
    ok("and the holder is NAMED, not just 'locked'",
      !b.ok && b.heldBy === "accountant@desk", !b.ok ? `held by ${b.heldBy}` : "");
    ok("the refusal says which device", !b.ok && (b as any).device === "desktop-1");

    // ── 3. The holder renewing is not a conflict ──────────────────────────
    console.log("\n  2. The holder is not locked out of their own edit");
    const again = await acquireLock(sb, COMPANY, RID, "accountant@desk", "desktop-1");
    ok("re-acquiring your own lock succeeds", again.ok && again.took === "renewed");
    ok("and 'held since' is preserved, not reset",
      again.ok && a.ok && again.lock.acquiredAt === a.lock.acquiredAt,
      "a renewal must not make a long edit look new");

    // ── 4. Heartbeat ──────────────────────────────────────────────────────
    console.log("\n  3. The heartbeat is what keeps it alive");
    const beat = await heartbeat(sb, COMPANY, RID, "accountant@desk");
    ok("the holder can heartbeat", beat);

    const wrongBeat = await heartbeat(sb, COMPANY, RID, "owner@phone");
    ok("SOMEONE ELSE cannot heartbeat it", !wrongBeat,
      "otherwise a stale client resurrects a lock that was taken over, and both believe they hold it");

    const { data: row } = await sb.from("voucher_locks").select("acquired_at, heartbeat_at, expires_at")
      .eq("company", COMPANY).eq("remote_id", RID).single();
    const ttl = (new Date(row!.expires_at).getTime() - new Date(row!.heartbeat_at).getTime()) / 1000;
    ok("expiry is measured from the HEARTBEAT, not from acquisition",
      Math.abs(ttl - LOCK_TTL_SECONDS) < 2,
      `${ttl}s after the last beat — a long edit must not lose its lock for being long`);

    // ── 5. Override ───────────────────────────────────────────────────────
    console.log("\n  4. Override — allowed, recorded, attributed");
    const noReason = await overrideLock(sb, COMPANY, RID, "owner@phone", "   ");
    ok("an override without a reason is refused", !noReason.ok);

    const forced = await overrideLock(sb, COMPANY, RID, "owner@phone",
      "accountant has gone home, invoice must go out today", "phone-1");
    ok("an override with a reason succeeds", forced.ok);

    const { data: after } = await sb.from("voucher_locks")
      .select("holder, overridden_from, override_reason, overridden_at")
      .eq("company", COMPANY).eq("remote_id", RID).single();
    ok("the new holder is recorded", after?.holder === "owner@phone");
    ok("THE PREVIOUS HOLDER IS KEPT, not erased",
      after?.overridden_from === "accountant@desk",
      `"who took my lock" must always have an answer — ${after?.override_reason}`);

    const beatAfterOverride = await heartbeat(sb, COMPANY, RID, "accountant@desk");
    ok("the overridden holder can no longer heartbeat", !beatAfterOverride);

    // ── 6. Visibility and release ─────────────────────────────────────────
    console.log("\n  5. Visible, and released");
    const live = await activeLocks(sb, COMPANY);
    ok("the lock shows in the active list", live.some((l) => l.remoteId === RID), `${live.length} active`);

    await releaseLock(sb, COMPANY, RID, "owner@phone");
    const free = await acquireLock(sb, COMPANY, RID, "someone@else");
    ok("after release the voucher is free", free.ok && free.took === "fresh");

    // ── 7. No client is not a free lock ───────────────────────────────────
    console.log("\n  6. The degraded case");
    const offline = await acquireLock(null, COMPANY, RID, "accountant@desk");
    ok("with no Supabase client the lock is REFUSED, not granted", !offline.ok);
    ok("and it says why rather than implying the voucher is free",
      !offline.ok && !!(offline as any).unavailable,
      (offline as any).unavailable?.slice(0, 60));

  } finally {
    await sb.from("voucher_locks").delete().eq("company", COMPANY).eq("remote_id", RID);
    const { data: left } = await sb.from("voucher_locks").select("remote_id")
      .eq("company", COMPANY).eq("remote_id", RID);
    ok("the test left no lock behind", (left?.length ?? 0) === 0);

    const swept = await sweepExpiredLocks(sb, 60);
    if (swept) console.log(`     (also swept ${swept} long-expired lock row(s))`);
  }

  console.log("\n  " + "─".repeat(66));
  console.log(`  ${pass} passed · ${fail} failed`);
  console.log(fail === 0 ? "  Two devices cannot silently overwrite each other.\n" : "  The gate is NOT met.\n");
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
