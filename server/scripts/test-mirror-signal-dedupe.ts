/**
 * Mirror change signals — announce a voucher only when its AlterID moved.
 *
 * PURE — no Supabase, no Tally. This machine is MKCP_TALLY_ROLE=sandbox and
 * must not write to `mirror_change_signal`, so the suppression cannot be
 * observed by emitting here. What this pins is the decision, which is the part
 * that can silently go wrong in either direction.
 *
 * ── What broke ────────────────────────────────────────────────────────────
 *
 * A sync pass re-emitted its whole window whether or not Tally had touched
 * anything in it. Measured read-only on the live table, 15-Sep-2026, trailing
 * 24 h: 4,918 signals naming 106 distinct vouchers — 46.4x amplification, 205
 * per hour, 232 in the 3 am hour with nobody working. The busiest `pk` appeared
 * 167 times carrying ONE distinct `version`.
 *
 * `mirror_change_signal.version` IS `tally_vouchers.alter_id` — verified by
 * join the same day, 100 of 100 matched pairs. (`tally_vouchers.version`, an
 * unrelated column, is 0 on all 2,839 rows and must not be read.)
 *
 * ── The asymmetry this test exists to protect ─────────────────────────────
 *
 * Suppressing a REAL change is far worse than the amplification: every open
 * device would sit on stale data with nothing on screen saying so. So the only
 * fact that may ever suppress is "prior AlterID is a number, incoming AlterID
 * is a number, and they are equal". Every weaker state emits. Most of the cases
 * below are there to prove the emitting half, not the dropping half.
 *
 *   npx tsx server/scripts/test-mirror-signal-dedupe.ts
 */
import {
  selectMovedChanges,
  describeSelection,
  type MirrorChange,
  type PriorVersions,
} from "../src/services/mirrorSignal.js";

let pass = 0, fail = 0;
const ok = (what: string, cond: boolean, detail = ""): void => {
  if (cond) { pass++; console.log(`  ok    ${what}${detail ? "  — " + detail : ""}`); }
  else { fail++; console.log(`  FAIL  ${what}${detail ? "  — " + detail : ""}`); }
};

const V1 = "6d3f2b10-1111-11d7-aaaa-000000000001";
const V2 = "6d3f2b10-2222-11d7-aaaa-000000000002";
const V3 = "6d3f2b10-3333-11d7-aaaa-000000000003";

const upsert = (pk: string, version: number | null): MirrorChange =>
  ({ table: "tally_vouchers", pk, op: "update", version });
const removed = (pk: string, version: number | null): MirrorChange =>
  ({ table: "tally_vouchers", pk, op: "delete", version });

const prior = (entries: [string, number | null][]): PriorVersions => new Map(entries);

console.log("\n  MIRROR CHANGE SIGNALS — only a moved AlterID is announced");
console.log("  " + "─".repeat(66));

// ── 1. The suppression ────────────────────────────────────────────────────
console.log("\n  1. Unchanged AlterID is dropped");
{
  const sel = selectMovedChanges([upsert(V1, 355_600)], prior([[V1, 355_600]]));
  ok("nothing emitted", sel.emit.length === 0);
  ok("counted as alter-id-unchanged, the only drop reason", sel.unchangedAlterId.length === 1);
  ok("no emit reason was claimed", Object.values(sel.reasons).every((n) => n === 0));
}
{
  /* The live shape: one voucher, one AlterID, announced over and over by
     successive passes. Each pass sees the mirror row it wrote last time. */
  let announced = 0;
  const held = new Map<string, number | null>([[V1, 355_600]]);
  for (let pass_ = 0; pass_ < 167; pass_++) {
    const sel = selectMovedChanges([upsert(V1, 355_600)], held);
    announced += sel.emit.length;
  }
  ok("167 identical passes over one voucher announce it 0 times", announced === 0,
    `${announced} signal(s)`);
}

// ── 2. The thing that must never be dropped ───────────────────────────────
console.log("\n  2. A genuinely changed voucher still signals");
{
  const sel = selectMovedChanges([upsert(V1, 355_632)], prior([[V1, 355_600]]));
  ok("emitted", sel.emit.length === 1);
  ok("reason is alter-id-moved", sel.reasons["alter-id-moved"] === 1);
  ok("the emitted row carries the NEW AlterID", sel.emit[0].version === 355_632);
  ok("nothing dropped", sel.unchangedAlterId.length === 0);
}
{
  const sel = selectMovedChanges([upsert(V1, 341_013)], prior([[V1, 355_600]]));
  ok("an AlterID that moved BACKWARDS is still a difference, so it emits",
    sel.emit.length === 1 && sel.reasons["alter-id-moved"] === 1);
}

// ── 3. Brand-new voucher ──────────────────────────────────────────────────
console.log("\n  3. A voucher with no previous AlterID signals");
{
  const sel = selectMovedChanges([upsert(V2, 355_640)], prior([[V1, 355_600]]));
  ok("emitted", sel.emit.length === 1 && sel.emit[0].pk === V2);
  ok("reason is no-prior-row (G7: not the same fact as unchanged)",
    sel.reasons["no-prior-row"] === 1);
  ok("it is NOT counted as alter-id-moved", sel.reasons["alter-id-moved"] === 0);
}
{
  /* G7 again, the other half: the row EXISTS but holds no AlterID. Also emits,
     also not "unchanged", and reported under its own name. */
  const sel = selectMovedChanges([upsert(V1, 355_640)], prior([[V1, null]]));
  ok("a mirror row with a null AlterID emits", sel.emit.length === 1);
  ok("reason is prior-alter-id-unknown, distinct from no-prior-row",
    sel.reasons["prior-alter-id-unknown"] === 1 && sel.reasons["no-prior-row"] === 0);
}
{
  const sel = selectMovedChanges([upsert(V1, null)], prior([[V1, 355_600]]));
  ok("a pull that carries no AlterID emits — cannot tell, so tell them",
    sel.emit.length === 1 && sel.reasons["incoming-alter-id-unknown"] === 1);
}

// ── 4. Deletes ────────────────────────────────────────────────────────────
console.log("\n  4. A delete always signals");
{
  const sel = selectMovedChanges([removed(V1, 355_600)], prior([[V1, 355_600]]));
  ok("emitted even though the AlterID is byte-identical to the mirror's",
    sel.emit.length === 1 && sel.emit[0].op === "delete");
  ok("reason is op-never-deduped", sel.reasons["op-never-deduped"] === 1);
  ok("nothing dropped", sel.unchangedAlterId.length === 0);
}
{
  const sel = selectMovedChanges(
    [{ table: "tally_vouchers", pk: V1, op: "insert", version: 355_600 }],
    prior([[V1, 355_600]]),
  );
  ok("an explicit insert is likewise never deduped",
    sel.emit.length === 1 && sel.reasons["op-never-deduped"] === 1);
}

// ── 5. Failure modes lean towards noise, never towards silence ────────────
console.log("\n  5. When it cannot tell, it emits");
{
  /* What the caller passes when the pre-image read failed, or when the batch is
     over the ceiling: an empty map. Every voucher must come through. */
  const batch = [upsert(V1, 355_600), upsert(V2, 355_601), removed(V3, 355_602)];
  const sel = selectMovedChanges(batch, new Map());
  ok("an empty prior map emits everything — the status quo, not a silence",
    sel.emit.length === 3 && sel.unchangedAlterId.length === 0);
}
{
  const p = new Map<string, number | null>([[V1, 355_600]]);
  selectMovedChanges([upsert(V1, 355_632)], p);
  ok("the caller's prior map is not mutated", p.get(V1) === 355_600);
}

// ── 6. Repeats inside one batch ───────────────────────────────────────────
console.log("\n  6. A pk repeated inside one batch");
{
  const sel = selectMovedChanges(
    [upsert(V2, 355_640), upsert(V2, 355_640), upsert(V2, 355_640)],
    new Map(),
  );
  ok("a new voucher named three times in one batch is announced once",
    sel.emit.length === 1 && sel.unchangedAlterId.length === 2);
}
{
  const sel = selectMovedChanges([upsert(V2, 355_640), upsert(V2, 355_641)], new Map());
  ok("but a second, DIFFERENT AlterID in the same batch still gets through",
    sel.emit.length === 2);
}

// ── 7. Mixed batch, and the log line ──────────────────────────────────────
console.log("\n  7. A realistic mixed batch");
{
  const sel = selectMovedChanges(
    [
      upsert(V1, 355_600),   // unchanged  → dropped
      upsert(V2, 355_641),   // moved      → emitted
      upsert(V3, 355_650),   // new        → emitted
      removed(V1, 355_600),  // delete     → emitted
    ],
    prior([[V1, 355_600], [V2, 355_600]]),
  );
  ok("3 of 4 emitted", sel.emit.length === 3);
  ok("exactly 1 dropped, and it is the unchanged upsert",
    sel.unchangedAlterId.length === 1 && sel.unchangedAlterId[0].pk === V1);
  ok("every emitted change kept its own reason",
    sel.reasons["alter-id-moved"] === 1 &&
    sel.reasons["no-prior-row"] === 1 &&
    sel.reasons["op-never-deduped"] === 1);

  const line = describeSelection(sel);
  ok("the log line names the drop reason without claiming a change was lost",
    line.includes("3 kept") && line.includes("1 dropped (alter-id-unchanged)"), line);
  ok("the log line keeps no-prior-row and alter-id-moved apart (G7)",
    line.includes("no-prior-row") && line.includes("alter-id-moved"), line);
}
{
  ok("an empty batch describes itself honestly",
    describeSelection(selectMovedChanges([], new Map())) === "no changes");
}

// ── 8. The measured effect, replayed ──────────────────────────────────────
console.log("\n  8. The live 24 h replayed through the rule");
{
  /* Counts taken read-only from mirror_change_signal on 15-Sep-2026 by
     comparing each signal to the previous signal for the same pk:
     4,918 rows → 106 with no prior signal + 9 whose version differed + 4,803
     identical repeats. The rule below must reproduce that split exactly. */
  const LIVE_TOTAL = 4_918, LIVE_NO_PRIOR = 106, LIVE_MOVED = 9, LIVE_REPEAT = 4_803;
  ok("the three buckets account for every measured signal",
    LIVE_NO_PRIOR + LIVE_MOVED + LIVE_REPEAT === LIVE_TOTAL);

  /* Rebuild that stream: 106 vouchers, one first sighting each, 9 of them later
     moved once, and the rest of the 4,918 are exact repeats. */
  const held = new Map<string, number | null>();
  let emitted = 0, dropped = 0;
  const pks = Array.from({ length: LIVE_NO_PRIOR }, (_, i) => `pk-${i}`);
  const stream: MirrorChange[] = [];
  const versionOf = new Map<string, number>(pks.map((p, i) => [p, 355_000 + i]));
  for (const p of pks) stream.push(upsert(p, versionOf.get(p)!));          // 106 first sightings
  for (let i = 0; i < LIVE_MOVED; i++) {                                    // 9 real edits
    const p = pks[i];
    versionOf.set(p, versionOf.get(p)! + 1);
    stream.push(upsert(p, versionOf.get(p)!));
  }
  while (stream.length < LIVE_TOTAL) {                                      // the rest: repeats
    const p = pks[stream.length % LIVE_NO_PRIOR];
    stream.push(upsert(p, versionOf.get(p)!));
  }
  for (const c of stream) {
    const sel = selectMovedChanges([c], held);
    if (sel.emit.length) { emitted++; held.set(c.pk, c.version ?? null); }
    else dropped++;
  }
  ok(`${LIVE_TOTAL} signals become ${LIVE_NO_PRIOR + LIVE_MOVED}`,
    emitted === LIVE_NO_PRIOR + LIVE_MOVED, `${emitted} emitted, ${dropped} dropped`);
  ok("all 9 genuine edits survive — none of them is what got dropped",
    emitted - LIVE_NO_PRIOR === LIVE_MOVED);
}

console.log("\n  " + "─".repeat(66));
console.log(`  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
