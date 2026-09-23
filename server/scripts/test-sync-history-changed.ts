/**
 * Pure unit test for `summarizeVoucherSync` (mirrorSignal.ts) — the function
 * that turns the before/after AlterID comparison every voucher sync already
 * does (for the mirror_change_signal hint) into `tally_sync_history.row_counts
 * .changed/.deleted/.maxAlterId`, and into the set of GUIDs a sync pass may
 * skip re-upserting.
 *
 * No Supabase, no Tally, no I/O — this only exercises the pure function
 * against fixtures for the five facts it has to get right:
 *
 *   new              — voucher has no prior row                → counts as changed
 *   altered          — AlterID moved since the prior row        → counts as changed
 *   unchanged        — AlterID equal to the prior row            → NOT changed, skippable
 *   deleted          — passed through from the caller's prune    → always present
 *   prior-read-failed — prior is null (read failed / above ceiling) → `changed` OMITTED
 *
 *   npx tsx server/scripts/test-sync-history-changed.ts
 */
import { summarizeVoucherSync, type PriorVersions } from "../src/services/mirrorSignal.js";

let pass = 0, fail = 0;

function ok(name: string, cond: boolean, detail?: string) {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); fail++; }
}

function eq(name: string, actual: unknown, expected: unknown) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  ok(name, same, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function main() {
  console.log("summarizeVoucherSync — pure diff fixtures\n");

  // ── new: no prior row at all ────────────────────────────────────────────
  {
    const prior: PriorVersions = new Map(); // empty — nothing held for this guid
    const r = summarizeVoucherSync([{ guid: "new-1", alterId: 5 }], prior, 0);
    eq("new voucher counts as changed", r.changed, 1);
    ok("new voucher is not in unchangedGuids", !r.unchangedGuids.has("new-1"));
    eq("maxAlterId reflects the new voucher", r.maxAlterId, 5);
  }

  // ── altered: AlterID moved since the prior row ──────────────────────────
  {
    const prior: PriorVersions = new Map([["alt-1", 10]]);
    const r = summarizeVoucherSync([{ guid: "alt-1", alterId: 12 }], prior, 0);
    eq("altered voucher counts as changed", r.changed, 1);
    ok("altered voucher is not in unchangedGuids", !r.unchangedGuids.has("alt-1"));
    // Moving BACKWARDS is still a move — must not be treated as unchanged.
    const back = summarizeVoucherSync([{ guid: "alt-2", alterId: 3 }], new Map([["alt-2", 10]]), 0);
    eq("a lower AlterID than on file still counts as changed", back.changed, 1);
  }

  // ── unchanged: AlterID equal to the prior row ───────────────────────────
  {
    const prior: PriorVersions = new Map([["same-1", 7], ["same-2", 8]]);
    const r = summarizeVoucherSync(
      [{ guid: "same-1", alterId: 7 }, { guid: "same-2", alterId: 8 }],
      prior,
      0,
    );
    eq("unchanged vouchers are not counted as changed", r.changed, 0);
    ok("unchanged voucher IS in unchangedGuids (skippable)", r.unchangedGuids.has("same-1") && r.unchangedGuids.has("same-2"));
  }

  // ── mixed batch: exercises new + altered + unchanged together ──────────
  {
    const prior: PriorVersions = new Map([["m-unchanged", 1], ["m-altered", 1], ["m-null-prior", null]]);
    const r = summarizeVoucherSync(
      [
        { guid: "m-unchanged", alterId: 1 },
        { guid: "m-altered", alterId: 2 },
        { guid: "m-new", alterId: 1 },
        // prior row exists but carries no AlterID (G7: not the same as "unchanged")
        { guid: "m-null-prior", alterId: 1 },
        // incoming has no AlterID — cannot be compared, must not be silently skipped
        { guid: "m-unchanged", alterId: null },
      ],
      prior,
      0,
    );
    // m-unchanged(1) unchanged, m-altered changed, m-new changed, m-null-prior changed,
    // and the repeated m-unchanged with a null incoming AlterID changed too.
    eq("mixed batch: 4 of 5 rows counted changed", r.changed, 4);
    ok("m-unchanged (numeric, equal) is skippable", r.unchangedGuids.has("m-unchanged"));
  }

  // ── deleted: always passed through, independent of changed/prior ───────
  {
    const r1 = summarizeVoucherSync([{ guid: "d-1", alterId: 1 }], new Map([["d-1", 1]]), 6);
    eq("deleted count passes through unchanged from the caller's prune", r1.deleted, 6);
    const r2 = summarizeVoucherSync([], null, 6);
    eq("deleted still reported even on an empty pull with unknown prior", r2.deleted, 6);
  }

  // ── prior-read-failed: prior is null → `changed` is OMITTED, not zero ──
  {
    const r = summarizeVoucherSync([{ guid: "unk-1", alterId: 9 }], null, 0);
    ok("changed is omitted (undefined) when prior read failed", r.changed === undefined,
      `got changed=${JSON.stringify(r.changed)}`);
    ok("unchangedGuids is empty when prior is unknown (fail open to upsert-everything)", r.unchangedGuids.size === 0);
    eq("maxAlterId is still computed even when prior is unknown", r.maxAlterId, 9);
  }

  // ── empty pull: NOT the same fact as prior-read-failed — 0 is known ────
  {
    const r = summarizeVoucherSync([], null, 0);
    eq("an empty pull reports changed:0, not omitted", r.changed, 0);
    eq("an empty pull has no maxAlterId", r.maxAlterId, null);
  }

  // ── maxAlterId ignores non-numeric AlterIDs ─────────────────────────────
  {
    const r = summarizeVoucherSync(
      [{ guid: "x", alterId: null }, { guid: "y", alterId: 4 }, { guid: "z", alterId: 2 }],
      new Map(),
      0,
    );
    eq("maxAlterId is the highest numeric AlterID, nulls ignored", r.maxAlterId, 4);
  }

  console.log(`\n${"─".repeat(56)}\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main();
