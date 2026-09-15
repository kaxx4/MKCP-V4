/*
 * Pull Sync, rebuilt from 0 on the web dashboard's idiom.
 *
 * ── What was wrong with the old one ───────────────────────────────────────
 *
 * Its four freshness tiles read from the local zustand store, and three of the
 * four could not tell the truth:
 *
 *   · "Masters"     — `lastMastersSyncAt`. `setLastMastersSync` exists in
 *                     store/tallyStore.ts and is called from NOWHERE in the
 *                     codebase. The tile has always rendered "—", on every
 *                     machine, since it was written.
 *   · "Full sync"   — `lastSyncAt`, which `triggerSync` stamps after ANY
 *                     successful manual pull: masters, daybook, a one-day
 *                     voucher window, even the price list. A tile labelled
 *                     "Full sync" that lights up after a 0.4s price-list
 *                     fetch is worse than no tile, because a full sweep is
 *                     the one pull that catches backdated entry and 61% of
 *                     the vouchers here are backdated.
 *   · "Last voucher"— the newest date the LAST PULL happened to see. Press
 *                     "Today" and it becomes today, whatever else is in the
 *                     books.
 *
 * And each printed `fmt(val).split(" ")[0]` — the date with the clock cut off.
 * On a panel that refreshes every ten seconds, "15/09/2026" reads as fresh
 * whether it ran four minutes or nineteen hours ago, and nineteen hours is
 * exactly the failure a freshness tile exists to catch.
 *
 * Its history was a six-column `<table>` whose error cell you had to click a
 * chevron to open — and the same runs are already listed below in MirrorPanel,
 * so the screen carried them twice in two shapes and neither showed the reason
 * without a click. Its rows column printed `items:412 ledgers:295` as one
 * unspaced run of text. The whole thing was painted in `bg-neutral-50` tiles,
 * `bg-red-50` error boxes and the green/red `Pill`.
 *
 * ── What this shows instead ───────────────────────────────────────────────
 *
 * Freshness is derived from `tally_sync_history` — the rows the server actually
 * writes, which carry a real type and a real row count — not from local flags
 * nobody sets. A full sweep is recognised the same way the server recognises
 * one (see server/src/services/mirrorPanel.ts: a voucher run of 500+ rows), so
 * this panel and that one cannot disagree.
 *
 * Then: the pulls a person can start, the heavy one still behind a confirm and
 * the reason spelled out when they are disabled; the runs that FAILED with
 * their reasons open and in full; and a short tail of the ones that worked. The
 * complete chronological list stays in MirrorPanel — one list, and this is the
 * panel that owns the reasons.
 */
import { useState } from "react";
import {
  AlertTriangle, CalendarClock, CheckCircle2, Database, History, Loader2,
  PackageSearch, RefreshCw, Tag,
} from "lucide-react";
import { StatusRow, RowGroupHeading, EmptyNote } from "./StatusRow";

/** Same threshold the server uses to call a voucher run a full sweep
 *  (server/src/services/mirrorPanel.ts, FULL_SYNC_MIN_VOUCHERS). Keep in step:
 *  if the two drift, this panel and MirrorPanel will disagree about whether the
 *  books have been swept, and there is no third opinion to break the tie. */
const FULL_SWEEP_MIN_VOUCHERS = 500;

export interface SyncHistoryRowLike {
  id: string;
  sync_type: "masters" | "vouchers";
  started_at: string;
  completed_at: string;
  success: boolean;
  duration_ms: number | null;
  chunk_count: number | null;
  row_counts: Record<string, number> | null;
  errors: string[] | null;
}

export interface PullAction {
  key: string;
  label: string;
  icon: typeof RefreshCw;
  /** Shown under the label — what this one actually costs. */
  note: string;
  /** Text of the confirm, or omitted for no confirm. */
  confirm?: string | null;
  run: () => void;
}

interface Props {
  actions: PullAction[];
  /** Voucher windows — same endpoint, different date range. */
  windows: Array<{ label: string; run: () => void }>;
  /** Label of the pull currently running, if any. */
  runningLabel: string | null;
  /** Any sync at all holds the global lock. */
  busy: boolean;
  /** Why nothing can be started, or null. */
  blocked: string | null;
  history: SyncHistoryRowLike[];
  /** False when the renderer has no Supabase read client — an empty list then
   *  means "could not ask", which must never be shown as "nothing happened". */
  canReadHistory: boolean;
}

/** Elapsed time, said the way a person says it. The old tiles printed a bare
 *  date and dropped the clock, which is the part that tells you whether the
 *  number on screen is this morning's. */
function ago(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

function dur(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

/** `items:412 ledgers:295` was one unreadable run of text. */
function counts(rc: Record<string, number> | null): string | null {
  if (!rc) return null;
  const parts = Object.entries(rc)
    .filter(([, v]) => Number(v) > 0)
    .map(([k, v]) => `${Number(v).toLocaleString("en-IN")} ${k.replace(/_/g, " ")}`);
  return parts.length ? parts.join(" · ") : null;
}

export function PullSyncPanel({
  actions, windows, runningLabel, busy, blocked, history, canReadHistory,
}: Props) {
  const [showAllRuns, setShowAllRuns] = useState(false);

  const failed = history.filter((h) => !h.success);
  const succeeded = history.filter((h) => h.success);
  const shownOk = showAllRuns ? succeeded : succeeded.slice(0, 5);

  /* `history` arrives newest-first, so the first match is the newest. */
  const newestMasters = succeeded.find((h) => h.sync_type === "masters") ?? null;
  const newestVouchers = succeeded.find((h) => h.sync_type === "vouchers") ?? null;
  const newestSweep =
    succeeded.find(
      (h) => h.sync_type === "vouchers" && Number(h.row_counts?.vouchers ?? 0) >= FULL_SWEEP_MIN_VOUCHERS,
    ) ?? null;

  /* "Not in the runs we can see" is not "never". The fetch is capped, so a
     sweep older than the window is invisible here, and saying "never" about it
     would send someone to re-pull a year they already have. */
  const sweepMeta = newestSweep
    ? ago(newestSweep.started_at)
    : history.length === 0
      /* "Not in the last 0 runs" is not a sentence. With nothing on record at
         all there is nothing to have looked through. */
      ? "no run on record"
      : `not in the last ${history.length} runs on record`;

  return (
    <div className="space-y-4">
      {/* The things that DO something, at the top. */}
      <div className="flex flex-wrap gap-2">
        {actions.map((a) => {
          const running = runningLabel === a.label;
          const Icon = a.icon;
          return (
            <button
              key={a.key}
              onClick={() => {
                if (a.confirm && !window.confirm(a.confirm)) return;
                a.run();
              }}
              disabled={busy || !!blocked}
              className="btn-secondary btn-sm !flex-col !items-start !gap-0 !py-1.5"
            >
              <span className="flex items-center gap-1.5">
                {running ? <Loader2 size={12} className="animate-spin" /> : <Icon size={12} />}
                {a.label}
              </span>
              <span className="text-[10px] font-medium text-neutral-500">{a.note}</span>
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10.5px] font-bold uppercase tracking-wide text-neutral-600">Vouchers only</span>
        {windows.map((w) => {
          const running = runningLabel === `Vouchers ${w.label}`;
          return (
            <button
              key={w.label}
              onClick={w.run}
              disabled={busy || !!blocked}
              className={`filter-chip text-[11px] ${running ? "filter-chip-active" : ""}`}
            >
              {running && <Loader2 size={10} className="animate-spin" />}
              {w.label}
            </button>
          );
        })}
      </div>

      {/* A flat-disabled button with no reason turns a two-second fix into a
          hunt through the log. */}
      {blocked && (
        <p className="flex items-start gap-1.5 text-[11.5px] text-warn-800">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          {blocked}
        </p>
      )}

      {/* 1 — what needs a person */}
      {failed.length > 0 && (
        <section>
          <RowGroupHeading tone="danger" icon={AlertTriangle}>
            Needs you — {failed.length} run{failed.length === 1 ? "" : "s"} failed
          </RowGroupHeading>
          <ul className="flex flex-col gap-2">
            {failed.map((h) => (
              <StatusRow
                key={h.id}
                icon={AlertTriangle}
                tone="danger"
                title={h.sync_type === "masters" ? "Masters sync" : "Voucher sync"}
                subject={counts(h.row_counts) ?? "nothing reached Supabase"}
                meta={`${new Date(h.started_at).toLocaleString("en-IN")} · ${dur(h.duration_ms)}${h.chunk_count ? ` · ${h.chunk_count} chunks` : ""}`}
                /* Open, and in full. This used to be behind a chevron in a
                   table cell, and the reason is the only useful part. */
                error={h.errors?.length ? h.errors.join(" · ") : "It failed and recorded no reason."}
              />
            ))}
          </ul>
        </section>
      )}

      {/* 2 and 3 — how stale the data is, then what already happened. Both
             read the same table, so when that read is unavailable they collapse
             into ONE notice rather than saying the same thing twice. */}
      {!canReadHistory ? (
        <div className="flex items-start gap-2 rounded-xl bg-warn-soft px-3 py-2.5 text-[12px] text-warn-800">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <div>
            <p className="font-semibold">Freshness and history cannot be read by this build.</p>
            <p className="mt-1">
              Both come from the sync history in Supabase, and this window has no read credentials — see the
              Supabase Cloud panel. Nothing below is stale or missing; it is unknown. Pulling itself is unaffected.
            </p>
          </div>
        </div>
      ) : (
        <>
          <section>
            <RowGroupHeading>Freshness</RowGroupHeading>
            <ul className="flex flex-col gap-2">
              <StatusRow
                icon={PackageSearch}
                tone={newestMasters ? "neutral" : "warn"}
                title="Masters"
                subject={newestMasters ? (counts(newestMasters.row_counts) ?? "no rows changed") : "no run on record"}
                meta={ago(newestMasters?.started_at ?? null)}
              />
              <StatusRow
                icon={Database}
                tone={newestVouchers ? "neutral" : "warn"}
                title="Vouchers"
                subject={newestVouchers ? (counts(newestVouchers.row_counts) ?? "no rows changed") : "no run on record"}
                meta={ago(newestVouchers?.started_at ?? null)}
              />
              <StatusRow
                icon={CalendarClock}
                tone={newestSweep ? "neutral" : "warn"}
                title="Full sweep"
                /* A run of small syncs makes the mirror look fresh while
                   backdated entry never arrives. Most of the entry here is
                   backdated, so this is the row that matters. */
                subject={`a voucher run of ${FULL_SWEEP_MIN_VOUCHERS.toLocaleString("en-IN")}+ rows — the only kind that catches backdated entry`}
                meta={sweepMeta}
              />
            </ul>
          </section>

          <section>
            <RowGroupHeading icon={History}>Recent successful runs</RowGroupHeading>
            {succeeded.length === 0 ? (
              <EmptyNote icon={History}>No successful run is on record yet.</EmptyNote>
            ) : (
              <>
                <ul className="flex flex-col gap-2">
                  {shownOk.map((h) => (
                    <StatusRow
                      key={h.id}
                      icon={CheckCircle2}
                      tone="success"
                      title={h.sync_type === "masters" ? "Masters sync" : "Voucher sync"}
                      subject={counts(h.row_counts) ?? "no rows changed"}
                      meta={`${new Date(h.started_at).toLocaleString("en-IN")} · ${dur(h.duration_ms)}${h.chunk_count ? ` · ${h.chunk_count} chunks` : ""}`}
                    />
                  ))}
                </ul>
                {succeeded.length > shownOk.length && (
                  <button
                    onClick={() => setShowAllRuns(true)}
                    className="mt-2 w-full rounded-lg px-3 py-1.5 text-[11.5px] font-medium text-neutral-500 transition-colors hover:bg-neutral-50 hover:text-neutral-700"
                  >
                    Show {succeeded.length - shownOk.length} more
                  </button>
                )}
              </>
            )}
          </section>
        </>
      )}

      <p className="flex items-start gap-1.5 text-[11px] text-neutral-500">
        <Tag size={11} className="mt-0.5 shrink-0" />
        The price list is one request for the whole catalogue, so it does not need a masters sync behind it.
      </p>
    </div>
  );
}

export default PullSyncPanel;
