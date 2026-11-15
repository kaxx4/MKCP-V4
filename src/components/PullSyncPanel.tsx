/*
 * The manual pulls from Tally and what the history says about them. Two parts, both drawn inside the Quick sync card (QuickSyncPanel.tsx):
 *
 *   PullButtons   the reads a person can start: whole year, parties and items, all vouchers, price list, and vouchers for a window.
 *   PullHistory   how fresh the data is, the runs that FAILED with their reasons open and in full, and a short tail of the ones that worked.
 *
 * ── Why the history is read the way it is ─────────────────────────────────
 *
 * Freshness comes from `tally_sync_history`, the rows the server actually writes, which carry a real type and a real row count, and not from
 * local flags nobody sets (`setLastMastersSync` is called from nowhere, and `lastSyncAt` is stamped by ANY manual pull, a 0.4 s price-list
 * fetch included). A full sweep is recognised the way the server recognises one (server/src/services/mirrorPanel.ts: a voucher run of 500 or
 * more rows), so this card and the Mirror card cannot disagree about whether the books have been swept. A time is told in words with its unit,
 * never a bare date, because a date reads as fresh whether the run was four minutes or nineteen hours ago.
 */
import { useState } from "react";
import { AlertTriangle, CalendarClock, CheckCircle2, Database, History, Loader2, PackageSearch, RefreshCw } from "lucide-react";
import { Chip, Disclosure, Note, Row, RowList, Tile, EmptyNote } from "./ui";

/** Same threshold the server uses to call a voucher run a full sweep (server/src/services/mirrorPanel.ts, FULL_SYNC_MIN_VOUCHERS). Keep in step. */
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
  /** Shown under the label: what this one actually costs. */
  note: string;
  /** Text of the confirm, or omitted for no confirm. */
  confirm?: string | null;
  run: () => void;
}

/** Elapsed time, said the way a person says it. */
function ago(iso: string | null): string {
  if (!iso) return "none";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

function dur(ms: number | null): string {
  if (ms == null) return "time not recorded";
  if (ms < 1000) return "under a second";
  if (ms < 60_000) return `${Math.round(ms / 1000)} seconds`;
  return `${Math.floor(ms / 60_000)} min ${Math.floor((ms % 60_000) / 1000)} sec`;
}

/** `items:412 ledgers:295` was one unreadable run of text. */
function counts(rc: Record<string, number> | null): string | null {
  if (!rc) return null;
  const parts = Object.entries(rc)
    .filter(([, v]) => Number(v) > 0)
    .map(([k, v]) => `${Number(v).toLocaleString("en-IN")} ${k.replace(/_/g, " ")}`);
  return parts.length ? parts.join(", ") : null;
}

/** The first reason that applies, so a grey button answers the question it raises. */
function whyOff(blocked: string | null, busy: boolean, runningLabel: string | null): string | null {
  if (blocked) return blocked;
  if (busy) return runningLabel ? `The ${runningLabel} sync is still running.` : "Another sync is holding the Tally connection.";
  return null;
}

/* ── the buttons ──────────────────────────────────────────────────────────────────────────────── */
interface ButtonsProps {
  actions: PullAction[];
  /** Voucher windows: same endpoint, different date range. */
  windows: Array<{ label: string; run: () => void }>;
  /** Label of the pull currently running, if any. */
  runningLabel: string | null;
  /** Any sync at all holds the global lock. */
  busy: boolean;
  /** Why nothing can be started, or null. */
  blocked: string | null;
}

export function PullButtons({ actions, windows, runningLabel, busy, blocked }: ButtonsProps) {
  return (
    <Tile title="Read something else from Tally">
      <ul className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
        {actions.map((a) => {
          const running = runningLabel === a.label;
          const Icon = a.icon;
          return (
            <li key={a.key} className="flex items-center gap-3">
              <span className="grid h-5 w-5 shrink-0 place-items-center">
                <Icon size={16} className="text-neutral-600" aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-neutral-900">{a.label}</div>
                <div className="text-xs text-neutral-700">{a.note}</div>
              </div>
              <button
                onClick={() => {
                  if (a.confirm && !window.confirm(a.confirm)) return;
                  a.run();
                }}
                disabled={busy || !!blocked}
                aria-label={`Read ${a.label} from Tally`}
                title={whyOff(blocked, busy, runningLabel) ?? `${a.label}: ${a.note}${a.confirm ? " (asks first)" : ""}`}
                className="btn-secondary shrink-0"
              >
                {running && <Loader2 size={16} className="animate-spin" />}
                {running ? "Reading" : "Read"}
              </button>
            </li>
          );
        })}
      </ul>

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-neutral-200 pt-3">
        <span className="mr-1 text-sm text-neutral-700">Vouchers only, for</span>
        {windows.map((w) => {
          const running = runningLabel === `Vouchers ${w.label}`;
          return (
            <button
              key={w.label}
              onClick={w.run}
              disabled={busy || !!blocked}
              title={whyOff(blocked, busy, runningLabel) ?? `Read every voucher in "${w.label}" from Tally.`}
              className={`filter-chip ${running ? "filter-chip-active" : ""}`}
            >
              {running && <Loader2 size={16} className="animate-spin" />}
              {w.label}
            </button>
          );
        })}
      </div>

      <p className="mt-3 text-xs text-neutral-700">
        The price list is read in one go for the whole catalogue, so it does not need a parties and items sync first.
      </p>
    </Tile>
  );
}

/* ── the history ──────────────────────────────────────────────────────────────────────────────── */
interface HistoryProps {
  history: SyncHistoryRowLike[];
  /** False when the renderer has no Supabase read client: an empty list then means "could not ask", which must never read as "nothing happened". */
  canReadHistory: boolean;
}

export function PullHistory({ history, canReadHistory }: HistoryProps) {
  const [showAllRuns, setShowAllRuns] = useState(false);

  if (!canReadHistory) {
    return (
      <Note tone="warn" icon={AlertTriangle}>
        <p className="font-medium">This version cannot read how fresh the data is or what ran before.</p>
        <p>
          Both come from the history kept in the online database, and this window has no read-only access to it. See the Online database card.
          Nothing below is old or missing. It is simply not known. Reading from Tally itself is not affected.
        </p>
      </Note>
    );
  }

  const failed = history.filter((h) => !h.success);
  const succeeded = history.filter((h) => h.success);
  const shownOk = showAllRuns ? succeeded : succeeded.slice(0, 5);

  /* `history` arrives newest-first, so the first match is the newest. */
  const newestMasters = succeeded.find((h) => h.sync_type === "masters") ?? null;
  const newestVouchers = succeeded.find((h) => h.sync_type === "vouchers") ?? null;
  const newestSweep =
    succeeded.find((h) => h.sync_type === "vouchers" && Number(h.row_counts?.vouchers ?? 0) >= FULL_SWEEP_MIN_VOUCHERS) ?? null;

  /* "Not in the runs we can see" is not "never": the fetch is capped, so a sweep older than the window is invisible here. */
  const sweepMissing = history.length === 0 ? "no run on record" : `not in the last ${history.length} runs on record`;

  const fresh: Array<{ key: string; icon: typeof Database; title: string; at: string | null; sub: string; missing: string }> = [
    { key: "m", icon: PackageSearch, title: "Parties and items", at: newestMasters?.started_at ?? null, sub: newestMasters ? (counts(newestMasters.row_counts) ?? "no rows changed") : "", missing: "no run on record" },
    { key: "v", icon: Database, title: "Vouchers", at: newestVouchers?.started_at ?? null, sub: newestVouchers ? (counts(newestVouchers.row_counts) ?? "no rows changed") : "", missing: "no run on record" },
    {
      /* A run of small syncs makes the copy look fresh while backdated entry never arrives. Most of the entry here is backdated, so this is the
         one that matters. */
      key: "s", icon: CalendarClock, title: "Whole-year check", at: newestSweep?.started_at ?? null,
      sub: `A voucher run of ${FULL_SWEEP_MIN_VOUCHERS.toLocaleString("en-IN")} or more rows. It is the only kind that catches entries made for an earlier date.`,
      missing: sweepMissing,
    },
  ];

  return (
    <>
      {/* 1: what needs a person */}
      {failed.length > 0 && (
        <Tile title={<span className="text-danger-700">Needs you: {failed.length} run{failed.length === 1 ? "" : "s"} failed</span>}>
          <RowList>
            {failed.map((h) => (
              <Row
                key={h.id}
                icon={AlertTriangle}
                tone="danger"
                title={h.sync_type === "masters" ? "Parties and items" : "Vouchers"}
                subject={counts(h.row_counts) ?? "nothing reached the online database"}
                meta={`${new Date(h.started_at).toLocaleString("en-IN")}. Took ${dur(h.duration_ms)}${h.chunk_count ? `, in ${h.chunk_count} part${h.chunk_count === 1 ? "" : "s"}` : ""}.`}
                /* Open, and in full: the reason is the only useful part. */
                error={h.errors?.length ? h.errors.join(". ") : "It failed and recorded no reason."}
              />
            ))}
          </RowList>
        </Tile>
      )}

      {/* 2: how stale the data is */}
      <div className="grid gap-2 sm:grid-cols-3">
        {fresh.map((f) => {
          const Icon = f.icon;
          return (
            <div key={f.key} className="tile flex flex-col items-start gap-1">
              <span className="flex items-center gap-2 text-sm font-medium text-neutral-900">
                <Icon size={16} className="text-neutral-600" aria-hidden="true" />
                {f.title}
              </span>
              {f.at ? <span className="font-display text-lg text-neutral-950">{ago(f.at)}</span> : <Chip tone="warn">{f.missing}</Chip>}
              {f.sub && <span className="text-xs text-neutral-700">{f.sub}</span>}
            </div>
          );
        })}
      </div>

      {/* 3: what already happened */}
      <Disclosure title="Recent runs that worked" badge={succeeded.length ? <Chip plain>{succeeded.length}</Chip> : undefined}>
        {succeeded.length === 0 ? (
          <EmptyNote icon={History}>No run that worked is on record yet.</EmptyNote>
        ) : (
          <>
            <RowList>
              {shownOk.map((h) => (
                <Row
                  key={h.id}
                  icon={CheckCircle2}
                  tone="success"
                  title={h.sync_type === "masters" ? "Parties and items" : "Vouchers"}
                  subject={counts(h.row_counts) ?? "no rows changed"}
                  meta={`${new Date(h.started_at).toLocaleString("en-IN")}. Took ${dur(h.duration_ms)}${h.chunk_count ? `, in ${h.chunk_count} part${h.chunk_count === 1 ? "" : "s"}` : ""}.`}
                />
              ))}
            </RowList>
            {succeeded.length > shownOk.length && (
              <button onClick={() => setShowAllRuns(true)} className="btn-ghost mt-2 w-full">
                Show {succeeded.length - shownOk.length} more
              </button>
            )}
          </>
        )}
      </Disclosure>
    </>
  );
}
