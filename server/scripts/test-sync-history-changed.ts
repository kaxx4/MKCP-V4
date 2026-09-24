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
import { summarizeVoucherSync, type PriorVersions, type EntryCounts } from "../src/services/mirrorSignal.js";
import { diffMasterRows, sameMasterValue, sumChanged } from "../src/services/masterDiff.js";

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

  // ── partial pull: same AlterID, FEWER entries than stored ───────────────
  // Live 23/24-Sep: the renderer's Today pull carried 83 ledger entries for 19
  // vouchers, its retry 30 s later 100, no AlterID moved. The short pass must
  // neither count as changed nor overwrite the stored entries.
  {
    const prior: PriorVersions = new Map([["p-1", 40], ["p-2", 41]]);
    const held = new Map<string, EntryCounts>([["p-1", { ledger: 5, inventory: 3 }], ["p-2", { ledger: 4, inventory: 2 }]]);
    const r = summarizeVoucherSync(
      [
        { guid: "p-1", alterId: 40, ledgerCount: 0, inventoryCount: 3 },
        { guid: "p-2", alterId: 41, ledgerCount: 4, inventoryCount: 2 },
      ],
      prior, 0, held,
    );
    eq("partial pull: nothing counted as changed", r.changed, 0);
    ok("partial voucher is in partialGuids (keep stored entries)", r.partialGuids.has("p-1"));
    ok("partial voucher is also skippable for the row upsert", r.unchangedGuids.has("p-1"));
    ok("complete unchanged voucher is NOT partial", !r.partialGuids.has("p-2") && r.unchangedGuids.has("p-2"));
  }

  // ── repair: same AlterID, MORE entries than stored ──────────────────────
  {
    const r = summarizeVoucherSync(
      [{ guid: "r-1", alterId: 40, ledgerCount: 5, inventoryCount: 3 }],
      new Map([["r-1", 40]]), 0,
      new Map([["r-1", { ledger: 0, inventory: 3 }]]),
    );
    eq("repair of a partial mirror row counts as changed", r.changed, 1);
    ok("repaired voucher is rewritten, not skipped", !r.unchangedGuids.has("r-1") && !r.partialGuids.has("r-1"));
    const mixed = summarizeVoucherSync(
      [{ guid: "r-2", alterId: 40, ledgerCount: 2, inventoryCount: 9 }],
      new Map([["r-2", 40]]), 0,
      new Map([["r-2", { ledger: 5, inventory: 3 }]]),
    );
    eq("one list grew, one shrank: rewrite (the safe side)", mixed.changed, 1);
  }

  // ── an edit that removes lines moves the AlterID, so it is never "partial" ──
  {
    const r = summarizeVoucherSync(
      [{ guid: "e-1", alterId: 41, ledgerCount: 2, inventoryCount: 1 }],
      new Map([["e-1", 40]]), 0,
      new Map([["e-1", { ledger: 5, inventory: 3 }]]),
    );
    eq("fewer entries with a NEW AlterID is an edit: changed", r.changed, 1);
    ok("an edit is never treated as partial", r.partialGuids.size === 0);
  }

  // ── no entry counts on file: AlterID alone decides, as before ───────────
  {
    const r = summarizeVoucherSync(
      [{ guid: "n-1", alterId: 7, ledgerCount: 0, inventoryCount: 0 }],
      new Map([["n-1", 7]]), 0, null,
    );
    eq("without stored counts an equal AlterID is unchanged", r.changed, 0);
    ok("and never partial", r.partialGuids.size === 0);
  }

  console.log("\ndiffMasterRows — masters pre-image fixtures\n");

  // ── masters: identical rows are not written and not counted ─────────────
  {
    const rows = [
      { guid: "g-1", company: "C", name: "A", opening_balance: "10", is_batch_wise: false, gst_details: [{ rate: 18, from: "2024-04-01" }], synced_at: "now" },
      { guid: "g-2", company: "C", name: "B", opening_balance: null, is_batch_wise: true, gst_details: null, synced_at: "now" },
    ];
    const prior = new Map<string, Record<string, unknown>>([
      // jsonb comes back with its keys reordered; synced_at is older
      ["g-1", { guid: "g-1", company: "C", name: "A", opening_balance: "10", is_batch_wise: false, gst_details: [{ from: "2024-04-01", rate: 18 }], synced_at: "then" }],
      ["g-2", { guid: "g-2", company: "C", name: "B", opening_balance: null, is_batch_wise: true, gst_details: null }],
    ]);
    const d = diffMasterRows(rows, prior);
    eq("identical master rows: changed 0", d.changed, 0);
    eq("identical master rows: nothing to write", d.toWrite.length, 0);
  }

  // ── masters: an edited field, a new row ─────────────────────────────────
  {
    const rows = [
      { guid: "g-1", name: "A", closing_balance: "12 PCS" },
      { guid: "g-3", name: "C", closing_balance: "1 PCS" },
    ];
    const prior = new Map<string, Record<string, unknown>>([["g-1", { guid: "g-1", name: "A", closing_balance: "11 PCS" }]]);
    const d = diffMasterRows(rows, prior);
    eq("edited + new master rows both counted", d.changed, 2);
    eq("and both written", d.toWrite.map((r) => r.guid), ["g-1", "g-3"]);
  }

  // ── masters: unknown pre-image fails open ───────────────────────────────
  {
    const rows = [{ guid: "g-1", name: "A" }];
    const d = diffMasterRows(rows, null);
    ok("unknown pre-image: changed omitted, not zero", d.changed === undefined);
    eq("unknown pre-image: every row written", d.toWrite.length, 1);
  }

  // ── masters: value comparison is strict where it matters ────────────────
  {
    ok("number written into a text column matches its string", sameMasterValue(5, "5"));
    ok("numeric column returned as a number matches", sameMasterValue(18, 18.0));
    ok("empty string is not null", !sameMasterValue("", null));
    ok("null is not the string 'null'", !sameMasterValue(null, "null"));
    ok("undefined new value is not compared (upsert keeps the stored one)",
      diffMasterRows([{ guid: "u", name: "A", gstapplicable: undefined }], new Map([["u", { guid: "u", name: "A", gstapplicable: "Applicable" }]])).changed === 0);
    ok("a changed jsonb value is a change", !sameMasterValue({ rate: 18 }, { rate: 12 }));
    ok("'007' and 7 are not collapsed unless one side is a number", !sameMasterValue("007", "7"));
  }

  // ── masters: keyed rows (GST rates use a composite key) ─────────────────
  {
    const keyOf = (r: Record<string, unknown>) => `${r.scope}|${r.name}|${r.effective_from}`;
    const rows = [{ scope: "item", name: "X", effective_from: "2024-04-01", gst_rate: 18, synced_at: "now" }];
    const same = diffMasterRows(rows, new Map([["item|X|2024-04-01", { scope: "item", name: "X", effective_from: "2024-04-01", gst_rate: 18 }]]), keyOf);
    eq("GST rate unchanged under a composite key", same.changed, 0);
    const moved = diffMasterRows(rows, new Map([["item|X|2024-04-01", { scope: "item", name: "X", effective_from: "2024-04-01", gst_rate: 12 }]]), keyOf);
    eq("GST rate change counted", moved.changed, 1);
  }

  // ── sumChanged: one unknown table makes the whole row unknown ───────────
  {
    eq("sum of known parts", sumChanged([0, 2, 0, 1]), 3);
    ok("any unknown part makes the total unknown", sumChanged([0, undefined, 3]) === undefined);
    eq("no parts is a known zero", sumChanged([]), 0);
  }

  console.log(`\n${"─".repeat(56)}\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main();
