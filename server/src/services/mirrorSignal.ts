/**
 * Tell the clients WHICH rows moved, not just that something did.
 *
 * ── What this replaces ────────────────────────────────────────────────────
 *
 * The agent inserts one row into `tally_sync_history`, and every open browser
 * reloads five tables — 2,792 vouchers, 8,703 ledger entries, 11,924 inventory
 * entries — plus a transform/index/margins pass. Measured: ~2.4 s of network per
 * reload. The agent writes 150-220 rows on a normal day, so even with 20 s
 * coalescing that is roughly 17 full reloads a session (280 in the worst one
 * recorded) to learn that one voucher moved.
 *
 * ── The rule that makes this safe ─────────────────────────────────────────
 *
 * A signal is a HINT, never a source of truth. Every consumer must be able to
 * ignore it and reload instead, and this module is written so that is always
 * the correct fallback:
 *
 *   · a failed signal write is swallowed — the sync itself must not fail
 *     because an optimisation could not be published;
 *   · a signal is emitted AFTER the row is committed, never before, so a client
 *     that reacts instantly cannot read a row that is not there yet;
 *   · above a threshold, no per-row signals are emitted at all. A full sync
 *     rewrites every voucher, and 2,792 individual signals would be slower for
 *     everyone than the single reload they were meant to avoid.
 *
 * The worst case a bug here can produce is a client doing exactly what it does
 * today. That is the property worth protecting.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Above this many changed rows, stay silent and let the reload happen.
 *
 * Chosen from the measured shapes rather than a round number: a day's real
 * trading is ~17 vouchers and the busiest hour writes a few hundred rows, while
 * a full sync rewrites 2,792. So a few hundred signals is the useful band, and
 * anything past it is a rebuild that a single reload handles better.
 */
export const SIGNAL_CEILING = 300;

export type MirrorOp = "insert" | "update" | "delete";

/**
 * ── The amplification, and the only thing that suppresses it ──────────────
 *
 * Measured read-only on the live table, 15-Sep-2026, over the trailing 24 h:
 * 4,918 signals naming 106 distinct vouchers — 46.4x. The busiest `pk` appeared
 * 167 times carrying ONE distinct `version`: same voucher, same AlterID,
 * announced 167 times. 205 signals/hour, including 232 in the 3 am hour with
 * nobody working. The cause is that a sync pass re-emits its whole window
 * whether or not Tally touched anything in it.
 *
 * Replayed against those same 4,918 rows, the rule below leaves 115: 106 first
 * sightings and 9 genuine AlterID moves.
 *
 * The rule is ONE fact and nothing else: Tally's AlterID for this voucher is a
 * number, the number the mirror already held for it is a number, and the two
 * are equal. Anything less certain emits. In particular this never looks at the
 * voucher's DATE — 61% of this business's entry is backdated, so a voucher's
 * date says nothing about whether its content moved.
 */

/**
 * What the mirror held for each pk BEFORE the pass that is now signalling.
 *
 * Key absent  → there is no such row; this voucher is new (G7: that is NOT the
 *               same fact as "unchanged", and it is never suppressed).
 * Value null  → the row exists but carries no AlterID, so nothing can be
 *               compared (G7 again: also not "unchanged", also never
 *               suppressed).
 * Value number→ the AlterID the mirror held, and the only input that can
 *               suppress anything.
 */
export type PriorVersions = ReadonlyMap<string, number | null>;

/** Why a change was kept. Every value except `alter-id-moved` means "could not tell". */
export type EmitReason =
  | "op-never-deduped"
  | "no-prior-row"
  | "prior-alter-id-unknown"
  | "incoming-alter-id-unknown"
  | "alter-id-moved";

export interface ChangeSelection {
  /** The changes to write. */
  emit: MirrorChange[];
  /** Dropped, and the ONLY reason anything is ever dropped: the AlterID did not move. */
  unchangedAlterId: MirrorChange[];
  /** Counts per reason, for a log line that says which fact applied. */
  reasons: Record<EmitReason, number>;
}

/**
 * Keep the changes whose AlterID actually moved (plus everything we cannot be
 * sure about). Pure — no Supabase, no clock, no I/O.
 *
 * `prior` is read from `tally_vouchers` BEFORE the upsert overwrites it, which
 * makes it the source of truth rather than a cache: the last signal for a
 * voucher carried exactly the AlterID that was in the mirror row at that
 * moment, because signals are only ever emitted after a successful upsert. A
 * caller that cannot obtain `prior` (read failed, above the ceiling) must pass
 * an EMPTY map, and every change then reads as `no-prior-row` and is emitted —
 * the failure mode is the noisy status quo, never a missed change.
 *
 * Within one batch a repeated pk is folded the same way, because the first
 * decision updates the working view of what the mirror will hold.
 */
export function selectMovedChanges(
  changes: readonly MirrorChange[],
  prior: PriorVersions,
): ChangeSelection {
  const emit: MirrorChange[] = [];
  const unchangedAlterId: MirrorChange[] = [];
  const reasons: Record<EmitReason, number> = {
    "op-never-deduped": 0,
    "no-prior-row": 0,
    "prior-alter-id-unknown": 0,
    "incoming-alter-id-unknown": 0,
    "alter-id-moved": 0,
  };

  /* A mutable view of what the mirror holds as this batch is applied, so a pk
     repeated inside one batch is compared against the decision just made for it
     rather than against the pre-batch value. */
  const held = new Map<string, number | null>(prior);

  const keep = (c: MirrorChange, why: EmitReason): void => {
    emit.push(c);
    reasons[why]++;
    if (c.op !== "delete" && typeof c.version === "number") held.set(c.pk, c.version);
  };

  for (const c of changes) {
    /* A delete is never deduped. The consumer treats op="delete" as a
       full-reload trigger and has nothing else to tell it a row went away; an
       insert is new by definition. Only an upsert-shaped "update" is a
       candidate for suppression at all. */
    if (c.op !== "update") {
      keep(c, "op-never-deduped");
      continue;
    }
    if (!held.has(c.pk)) {
      keep(c, "no-prior-row");
      continue;
    }
    const before = held.get(c.pk);
    if (typeof before !== "number") {
      keep(c, "prior-alter-id-unknown");
      continue;
    }
    if (typeof c.version !== "number") {
      keep(c, "incoming-alter-id-unknown");
      continue;
    }
    if (c.version === before) {
      unchangedAlterId.push(c);
      continue;
    }
    /* Moved — including BACKWARDS. A lower AlterID than the one on file is
       still a difference from what every client holds, so it is announced. */
    keep(c, "alter-id-moved");
  }

  return { emit, unchangedAlterId, reasons };
}

/** One voucher's identity and AlterID, as `syncVouchers` already has it in hand. */
export interface VoucherAlterState {
  guid: string;
  alterId: number | null;
}

/**
 * What a voucher sync pass should report and act on, derived from the SAME
 * before/after AlterID comparison `selectMovedChanges` uses for the mirror
 * signal — but answering two different questions with it:
 *
 *   1. `tally_sync_history.row_counts` — how many rows actually moved, so the
 *      web side can tell a real sync from a no-op one instead of treating
 *      every completed row as "go reload everything" (see mirrorPanel.ts /
 *      the freshness chips).
 *   2. `unchangedGuids` — which voucher rows are safe to skip re-upserting
 *      this pass, because their AlterID provably did not move.
 *
 * `changed` is OMITTED (not zero) when `prior` is null — a failed pre-image
 * read or a pull above SIGNAL_CEILING. The web side must treat a missing
 * `changed` as "unknown, reload to be safe", never as "nothing changed". An
 * empty pull (`vouchers.length === 0`, e.g. a pure per-day prune pass with
 * nothing to upsert) is NOT the same fact — there is nothing to compare, so
 * `changed: 0` is a real, known answer, not an unknown one.
 *
 * `deleted` is always known (the orphan prune is authoritative regardless of
 * whether the AlterID pre-image read succeeded) — the caller passes in
 * whatever the prune actually removed, and this function never touches it
 * beyond passing it through.
 *
 * `unchangedGuids` is empty whenever `prior` is null: "cannot tell" must fail
 * open to "upsert everything", exactly like `selectMovedChanges` already does
 * for the mirror signal via `priorAlterIds ?? new Map()`. This function must
 * NEVER weaken the per-day prune / mass-deletion guard — it only decides
 * which rows get re-upserted, not which days or GUIDs are authoritative for
 * deletion. That set (`voucherGuids`, built from every pulled voucher
 * regardless of whether its AlterID moved) is untouched by this function.
 *
 * Pure — no Supabase, no clock, no I/O. See
 * server/scripts/test-sync-history-changed.ts for the fixtures.
 */
export interface VoucherSyncCounts {
  changed?: number;
  deleted: number;
  maxAlterId: number | null;
  unchangedGuids: ReadonlySet<string>;
}

export function summarizeVoucherSync(
  vouchers: readonly VoucherAlterState[],
  prior: PriorVersions | null,
  deleted: number,
): VoucherSyncCounts {
  // Nothing pulled: there is nothing to compare, so 0 is a known answer, not
  // an unknown one — do not fall through to the "prior is null" branch below,
  // which would wrongly omit `changed` for an ordinary empty-day prune pass.
  if (vouchers.length === 0) {
    return { changed: 0, deleted, maxAlterId: null, unchangedGuids: new Set() };
  }

  let maxAlterId: number | null = null;
  for (const v of vouchers) {
    if (typeof v.alterId === "number" && (maxAlterId === null || v.alterId > maxAlterId)) {
      maxAlterId = v.alterId;
    }
  }

  if (prior === null) {
    return { deleted, maxAlterId, unchangedGuids: new Set() };
  }

  const unchangedGuids = new Set<string>();
  let changed = 0;
  for (const v of vouchers) {
    const before = prior.get(v.guid);
    const hasPrior = prior.has(v.guid);
    const same =
      hasPrior && typeof before === "number" && typeof v.alterId === "number" && v.alterId === before;
    if (same) {
      unchangedGuids.add(v.guid);
    } else {
      changed++;
    }
  }
  return { changed, deleted, maxAlterId, unchangedGuids };
}

/** One line saying which fact applied to how many changes. Empty when nothing was kept. */
export function describeSelection(sel: ChangeSelection): string {
  const kept = (Object.entries(sel.reasons) as [EmitReason, number][])
    .filter(([, n]) => n > 0)
    .map(([why, n]) => `${n} ${why}`)
    .join(", ");
  const dropped = sel.unchangedAlterId.length;
  if (!kept && !dropped) return "no changes";
  return `${sel.emit.length} kept${kept ? ` (${kept})` : ""}, ${dropped} dropped (alter-id-unchanged)`;
}

export interface MirrorChange {
  table: string;
  pk: string;
  op: MirrorOp;
  /** Tally's ALTERID where there is one, so a client can order two signals. */
  version?: number | null;
}

export interface SignalOutcome {
  emitted: number;
  /** True when the ceiling was hit and clients should expect a full reload. */
  suppressed: boolean;
  note: string;
}

/**
 * Publish a batch of changes.
 *
 * Never throws. A caller must be able to write this line into a sync path
 * without wrapping it, because a sync that fails for want of a hint is strictly
 * worse than a client that reloads.
 */
export async function emitMirrorChanges(
  sb: SupabaseClient | null,
  company: string,
  changes: MirrorChange[],
): Promise<SignalOutcome> {
  if (!sb || changes.length === 0) {
    return { emitted: 0, suppressed: false, note: "nothing to publish" };
  }

  if (changes.length > SIGNAL_CEILING) {
    /* Deliberately silent. Clients still get the tally_sync_history row and do
       what they do today; emitting 2,792 signals would cost more than the
       reload it was meant to replace. Said out loud in the return value so a
       caller logging this can tell "suppressed" from "failed". */
    return {
      emitted: 0,
      suppressed: true,
      note: `${changes.length} changes exceeds the ${SIGNAL_CEILING} ceiling — left to the full-reload path, which handles a rebuild better than per-row patches would`,
    };
  }

  const rows = changes.map((c) => ({
    company,
    table_name: c.table,
    pk: c.pk,
    op: c.op,
    version: c.version ?? null,
  }));

  try {
    const { error } = await sb.from("mirror_change_signal").insert(rows);
    if (error) {
      return { emitted: 0, suppressed: false, note: `signal insert failed (harmless): ${error.message}` };
    }
    return { emitted: rows.length, suppressed: false, note: `${rows.length} change(s) published` };
  } catch (e: any) {
    // Swallowed on purpose — see the header.
    return { emitted: 0, suppressed: false, note: `signal insert threw (harmless): ${e?.message ?? e}` };
  }
}

/**
 * Delete hints older than a day.
 *
 * They are worthless past every client's fallback window, and an append-only
 * table nobody prunes becomes the next thing someone has to discover.
 */
export async function pruneMirrorSignals(sb: SupabaseClient | null, olderThanHours = 24): Promise<number> {
  if (!sb) return 0;
  const cutoff = new Date(Date.now() - olderThanHours * 3_600_000).toISOString();
  try {
    const { data } = await sb.from("mirror_change_signal").delete().lt("created_at", cutoff).select("id");
    return data?.length ?? 0;
  } catch {
    return 0;
  }
}
