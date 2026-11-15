/*
 * The push queue, rebuilt on the web dashboard's idiom.
 *
 * ── What was wrong with the old one ───────────────────────────────────────
 *
 * It repeated the header. "Agent running", "Tally healthy", and the
 * pending/pushing/failed counts are now the KPI strip at the top of the page,
 * so showing them again as pills meant the same four facts twice on one screen
 * and neither copy being the obvious one to read.
 *
 * It was painted in raw palette utilities — `bg-accent-soft text-accent-700`,
 * `bg-warn-soft`, `bg-danger-soft` — rather than the semantic tokens the rest of
 * both apps uses, so "failed" here was a different red from "failed" three
 * inches away in the web dashboard.
 *
 * Its two lists were a bare `<table>` and a stack of red boxes, where the web
 * dashboard has one row shape for a queued voucher: an icon tile carrying the
 * status, the voucher and party, a meta line, and the error where the error
 * belongs. A person moving between the two screens had to learn both.
 *
 * And its advice was out of date in a way that mattered: it told the operator
 * to fix `server/.env`, a file that stopped shipping when the service-role key
 * came out of the installer. Following it would have led to editing a file that
 * is not there.
 *
 * ── What this shows instead ───────────────────────────────────────────────
 *
 * The work, in the order it needs a person: what is stuck, then what is
 * waiting, then what went. Counts live in the header strip; this panel is for
 * the rows behind them.
 */
import { useState } from "react";
import {
  Activity, AlertTriangle, CheckCircle2, Clock, Loader2, RotateCcw,
  RefreshCw, CloudOff,
} from "lucide-react";
/* The row this panel invented now lives in StatusRow.tsx, because the four
   panels rebuilt after it list the same kind of fact and were each about to
   grow their own copy. Rendered output is unchanged. */
import { StatusRow, RowGroupHeading, EmptyNote } from "./StatusRow";

export interface PushAgentStatusLike {
  enabled: boolean;
  lastTick: string | null;
  tallyHealthy: boolean;
  queueStats: { pending: number; pushing: number; failed: number };
  /** When those counts were last read out of Supabase; null means never — the
   *  initial zeros rather than a measured empty queue. Absent on a server
   *  older than 15-Sep-2026, which is also "cannot tell". */
  queueStatsAt?: string | null;
}

export interface PushLogRowLike {
  id: string;
  voucher_type: string | null;
  party: string | null;
  date: string | null;
  status: "succeeded" | "failed";
  tally_vch_id: string | null;
  attempts: number;
  last_error: string | null;
  line_errors: string[] | null;
  resolved_at: string;
}

export interface FailedJobLike {
  id: string;
  idempotency_key: string;
  payload: Record<string, unknown>;
  attempts: number;
  last_error: string | null;
  created_at: string;
}

interface Props {
  status: PushAgentStatusLike | null;
  unreachable: boolean;
  baseLabel: string;
  log: PushLogRowLike[];
  failedJobs: FailedJobLike[];
  draining: boolean;
  onDrain: () => void;
  requeueingId: string | null;
  onRequeue: (id: string) => void;
  fmtTime: (iso: string | null | undefined) => string;
}

export function PushQueuePanel({
  status, unreachable, baseLabel, log, failedJobs,
  draining, onDrain, requeueingId, onRequeue, fmtTime,
}: Props) {
  const [showAll, setShowAll] = useState(false);

  if (unreachable) {
    return (
      <div className="note note-bad">
        <CloudOff size={16} className="mt-1 shrink-0" />
        <span>
          This app's own server on {baseLabel} is not answering, so nothing can be sent from here. Closing the app and
          opening it again is the usual fix.
        </span>
      </div>
    );
  }

  if (!status) {
    return <p className="flex items-center gap-2 py-2 text-sm text-neutral-700"><Loader2 size={16} className="animate-spin" /> Reading the old sender</p>;
  }

  const queueKnown = !!status.queueStatsAt;
  const waiting = status.queueStats.pending + status.queueStats.pushing;
  const shown = showAll ? log : log.slice(0, 8);
  const nothingAtAll = queueKnown && failedJobs.length === 0 && waiting === 0 && log.length === 0;

  return (
    <div className="space-y-4">
      {/* The drain control sits alone at the top — it is the only thing in this
          panel that DOES something to the books. */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={onDrain}
          disabled={draining || !status.enabled}
          title={!status.enabled ? "The old sender is not running. The reason is written below." : undefined}
          className="btn-secondary btn-sm"
        >
          {draining ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
          Send what is waiting now
        </button>
        {/* "Nothing waiting" was printed from counters that had never been
            read. See server/src/services/pushAgent.ts:refreshQueueStats,
            which only runs at the end of a completed tick and never runs at
            all when the agent could not start. (15-Sep-2026) */}
        <span className="text-xs text-neutral-700">
          {!queueKnown
            ? "The queue has not been counted yet, so nothing here says it is empty."
            : waiting > 0
              ? `${waiting} waiting. They are picked up by themselves every few seconds.`
              : "Nothing is waiting. Anything new is picked up by itself."}
        </span>
      </div>

      {/* Why the drain is off. Three causes, and the old copy named one of them
          and pointed at a file that no longer ships. */}
      {!status.enabled && (
        <div className="note note-warn">
          <AlertTriangle size={16} className="mt-1 shrink-0" />
          <div>
            <p className="font-medium">The old sender is not running, so vouchers waiting in the old queue stay there.</p>
            <p className="mt-1">This usually means one of three things:</p>
            <ul className="mt-1 list-disc space-y-1 pl-5">
              <li>It has been switched off on this computer.</li>
              <li>This computer is a practice machine, and a practice machine never sends from the real queue.</li>
              <li>This computer cannot reach the online database.</li>
            </ul>
            <p className="mt-1">
              Ask whoever looks after this computer to check, then close this app and open it again.
            </p>
          </div>
        </div>
      )}

      {nothingAtAll && (
        <EmptyNote icon={Activity}>Nothing has been sent from this computer yet.</EmptyNote>
      )}

      {/* 1 — what needs a person */}
      {failedJobs.length > 0 && (
        <section>
          <RowGroupHeading tone="danger" icon={AlertTriangle}>
            Needs you: {failedJobs.length} refused by Tally
          </RowGroupHeading>
          <ul className="tray flex flex-col gap-2">
            {failedJobs.map((job) => (
              <StatusRow
                key={job.id}
                icon={AlertTriangle}
                tone="danger"
                title={String((job.payload as { voucherType?: string })?.voucherType ?? "Voucher")}
                subject={String((job.payload as { partyLedgerName?: string })?.partyLedgerName ?? "")}
                meta={`Tried ${job.attempts} time${job.attempts === 1 ? "" : "s"}. Queued ${fmtTime(job.created_at)}.`}
                error={job.last_error}
                action={
                  <button
                    onClick={() => onRequeue(job.id)}
                    disabled={requeueingId === job.id}
                    className="btn-secondary btn-sm"
                  >
                    {requeueingId === job.id ? <Loader2 size={16} className="animate-spin" /> : <RotateCcw size={16} />}
                    Try again
                  </button>
                }
              />
            ))}
          </ul>
        </section>
      )}

      {/* 2 — what already went */}
      {log.length > 0 && (
        <section>
          <RowGroupHeading>Recently sent</RowGroupHeading>
          <ul className="tray flex flex-col gap-2">
            {shown.map((row) => (
              <StatusRow
                key={row.id}
                icon={row.status === "succeeded" ? CheckCircle2 : AlertTriangle}
                tone={row.status === "succeeded" ? "success" : "danger"}
                title={row.voucher_type || "Voucher"}
                subject={row.party}
                meta={[
                  row.date,
                  fmtTime(row.resolved_at),
                  row.tally_vch_id ? `Tally number ${row.tally_vch_id}` : null,
                ].filter(Boolean).join(" · ")}
                error={row.status === "failed" ? (row.line_errors?.join(" · ") || row.last_error) : null}
              />
            ))}
          </ul>
          {log.length > shown.length && (
            <button
              onClick={() => setShowAll(true)}
              className="btn-ghost mt-2 w-full"
            >
              Show {log.length - shown.length} more
            </button>
          )}
        </section>
      )}

      {status.lastTick && (
        <p className="flex items-center gap-2 text-xs text-neutral-700">
          <Clock size={16} /> Last checked {fmtTime(status.lastTick)}
          {!status.tallyHealthy && ". Tally was not answering then."}
        </p>
      )}
    </div>
  );
}

export default PushQueuePanel;
