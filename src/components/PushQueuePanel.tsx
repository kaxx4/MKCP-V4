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
 * It was painted in raw palette utilities — `bg-blue-50 text-blue-800`,
 * `bg-yellow-50`, `bg-red-100` — rather than the semantic tokens the rest of
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
  RefreshCw, CloudOff, type LucideIcon,
} from "lucide-react";
import clsx from "clsx";

export interface PushAgentStatusLike {
  enabled: boolean;
  lastTick: string | null;
  tallyHealthy: boolean;
  queueStats: { pending: number; pushing: number; failed: number };
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

/** One row of the queue, shaped like the web dashboard's `PushQueueList`. */
function QueueRow({
  icon: Icon, tone, title, party, meta, error, action, spinning,
}: {
  icon: LucideIcon;
  tone: "neutral" | "success" | "danger";
  title: string;
  party?: string | null;
  meta?: string;
  error?: string | null;
  action?: React.ReactNode;
  spinning?: boolean;
}) {
  const toneCls =
    tone === "success" ? "bg-success/10 text-success-700"
    : tone === "danger" ? "bg-danger/10 text-danger-700"
    : "bg-neutral-100 text-neutral-700";

  return (
    <li className="rounded-xl bg-white ring-1 ring-black/[0.06] px-3 py-2.5">
      <div className="flex items-start gap-3">
        <span className={clsx("grid h-9 w-9 shrink-0 place-items-center rounded-lg", toneCls)}>
          <Icon size={16} className={spinning ? "animate-spin" : undefined} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-[13px] font-semibold text-neutral-900">{title}</span>
                {party && <span className="truncate text-[12.5px] text-neutral-700">{party}</span>}
              </div>
              {meta && <div className="text-[11px] tabular-nums text-neutral-500">{meta}</div>}
            </div>
            {action && <div className="shrink-0">{action}</div>}
          </div>
          {/* The reason sits with the row it belongs to, not in a table cell
              you have to click to expand. */}
          {error && (
            <p className="mt-1 break-words rounded bg-danger-soft px-2 py-1 text-[11px] text-danger-700">{error}</p>
          )}
        </div>
      </div>
    </li>
  );
}

export function PushQueuePanel({
  status, unreachable, baseLabel, log, failedJobs,
  draining, onDrain, requeueingId, onRequeue, fmtTime,
}: Props) {
  const [showAll, setShowAll] = useState(false);

  if (unreachable) {
    return (
      <div className="flex items-start gap-2 rounded-xl bg-danger-soft px-3 py-2.5 text-[12.5px] text-danger-700">
        <CloudOff size={14} className="mt-0.5 shrink-0" />
        <span>
          The local server on <code className="font-mono">{baseLabel}</code> is not answering, so nothing can be
          pushed from here. Restarting the app is the usual fix.
        </span>
      </div>
    );
  }

  if (!status) {
    return <p className="flex items-center gap-2 py-2 text-[12.5px] text-neutral-500"><Loader2 size={13} className="animate-spin" /> Reading the push agent…</p>;
  }

  const waiting = status.queueStats.pending + status.queueStats.pushing;
  const shown = showAll ? log : log.slice(0, 8);
  const nothingAtAll = failedJobs.length === 0 && waiting === 0 && log.length === 0;

  return (
    <div className="space-y-4">
      {/* The drain control sits alone at the top — it is the only thing in this
          panel that DOES something to the books. */}
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={onDrain} disabled={draining || !status.enabled} className="btn-secondary btn-sm">
          {draining ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
          Drain now
        </button>
        <span className="text-[11.5px] text-neutral-600">
          {waiting > 0
            ? `${waiting} waiting · the agent picks these up on its own every few seconds`
            : "Nothing waiting — the agent drains automatically."}
        </span>
      </div>

      {/* Why the drain is off. Three causes, and the old copy named one of them
          and pointed at a file that no longer ships. */}
      {!status.enabled && (
        <div className="flex items-start gap-2 rounded-xl bg-warn-soft px-3 py-2.5 text-[12px] text-warn-800">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <div>
            <p className="font-semibold">The drain agent is not running, so queued vouchers stay queued.</p>
            <p className="mt-1">
              All three must hold in <code className="font-mono">%APPDATA%\mkcycles-dashboard-electron\.env</code>:
            </p>
            <ul className="mt-1 space-y-0.5">
              <li>· <code className="font-mono">PUSH_AGENT_ENABLED=true</code></li>
              <li>· <code className="font-mono">MKCP_TALLY_ROLE=primary</code> — on <code className="font-mono">sandbox</code> it refuses to claim jobs and nothing says why</li>
              <li>· <code className="font-mono">SUPABASE_URL</code> and <code className="font-mono">SUPABASE_SERVICE_KEY</code> set</li>
            </ul>
            <p className="mt-1">
              <strong>Then restart this app</strong> — the server reads its environment once, at startup.
              That folder is named after the package, not the product; the app logs the path it actually read.
            </p>
          </div>
        </div>
      )}

      {nothingAtAll && (
        <div className="flex flex-col items-center gap-1.5 rounded-xl bg-bg-sub px-4 py-8 text-center">
          <Activity size={20} className="text-neutral-300" />
          <span className="text-[13px] text-neutral-500">Nothing has been pushed from this machine yet.</span>
        </div>
      )}

      {/* 1 — what needs a person */}
      {failedJobs.length > 0 && (
        <section>
          <h3 className="mb-1.5 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-danger-700">
            <AlertTriangle size={12} /> Needs you — {failedJobs.length} refused
          </h3>
          <ul className="flex flex-col gap-2">
            {failedJobs.map((job) => (
              <QueueRow
                key={job.id}
                icon={AlertTriangle}
                tone="danger"
                title={String((job.payload as { voucherType?: string })?.voucherType ?? "Voucher")}
                party={String((job.payload as { partyLedgerName?: string })?.partyLedgerName ?? "")}
                meta={`attempt ${job.attempts} · queued ${fmtTime(job.created_at)}`}
                error={job.last_error}
                action={
                  <button
                    onClick={() => onRequeue(job.id)}
                    disabled={requeueingId === job.id}
                    className="btn-secondary btn-sm"
                  >
                    {requeueingId === job.id ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
                    Re-queue
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
          <h3 className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-neutral-600">
            Recently pushed
          </h3>
          <ul className="flex flex-col gap-2">
            {shown.map((row) => (
              <QueueRow
                key={row.id}
                icon={row.status === "succeeded" ? CheckCircle2 : AlertTriangle}
                tone={row.status === "succeeded" ? "success" : "danger"}
                title={row.voucher_type || "Voucher"}
                party={row.party}
                meta={[
                  row.date,
                  fmtTime(row.resolved_at),
                  row.tally_vch_id ? `Tally id ${row.tally_vch_id}` : null,
                ].filter(Boolean).join(" · ")}
                error={row.status === "failed" ? (row.line_errors?.join(" · ") || row.last_error) : null}
              />
            ))}
          </ul>
          {log.length > shown.length && (
            <button
              onClick={() => setShowAll(true)}
              className="tap mt-2 w-full rounded-lg px-3 py-1.5 text-[11.5px] font-medium text-neutral-500 transition-colors hover:bg-neutral-50 hover:text-neutral-700"
            >
              Show {log.length - shown.length} more
            </button>
          )}
        </section>
      )}

      {status.lastTick && (
        <p className="flex items-center gap-1.5 text-[11px] text-neutral-500">
          <Clock size={11} /> Last checked {fmtTime(status.lastTick)}
          {!status.tallyHealthy && " · Tally was not answering then"}
        </p>
      )}
    </div>
  );
}

export default PushQueuePanel;
