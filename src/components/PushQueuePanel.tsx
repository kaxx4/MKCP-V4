/*
 * The push queue card: vouchers that wait in the online database to be sent into Tally by the old sender. Shown only where office mode is off
 * (after go-live the office computer's card, PrimaryCard.tsx, takes this place).
 *
 * It opens with the two readings about the old sender (is it running, how many are waiting; status/agentFacts.ts), then the work in the order it
 * needs a person: what is stuck, then what already went. The one control that DOES something to the books, "Send what is waiting now", sits
 * alone at the top.
 *
 * "Nothing waiting" is only said when the queue has actually been counted: the counters hold their initial zeros until a drain tick has read them
 * out of the online database (server/src/services/pushAgent.ts:refreshQueueStats), and three paths never get there (no key, first tick not
 * finished, read failed). A queue reported as empty is a queue nobody goes to look at.
 */
import { useState } from "react";
import { Activity, AlertTriangle, CheckCircle2, Clock, CloudOff, Loader2, RefreshCw, RotateCcw } from "lucide-react";
import type { AgentFact } from "../status/agentFacts";
import { Card, EmptyNote, Fact, Note, Row, RowList, Tile } from "./ui";

export interface PushAgentStatusLike {
  enabled: boolean;
  lastTick: string | null;
  tallyHealthy: boolean;
  queueStats: { pending: number; pushing: number; failed: number };
  /** When those counts were last read out of Supabase; null means never: the initial zeros rather than a measured empty queue. */
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
  /** The two readings about the old sender, from drainFact() and queueFact(). */
  facts: AgentFact[];
}

export function PushQueueCard({
  status, unreachable, baseLabel, log, failedJobs, draining, onDrain, requeueingId, onRequeue, fmtTime, facts,
}: Props) {
  const [showAll, setShowAll] = useState(false);

  const head = { icon: Activity, title: "Push queue", sub: "Vouchers the online database sends on to Tally, and what happened to them." };

  const factTiles = <div className="grid gap-2 sm:grid-cols-2">{facts.map((f) => <Fact key={f.label} fact={f} />)}</div>;

  if (unreachable) {
    return (
      <Card {...head}>
        {factTiles}
        <Note tone="bad" icon={CloudOff}>
          <p>
            This app's own server on {baseLabel} is not answering, so nothing can be sent from here. Closing the app and
            opening it again is the usual fix.
          </p>
        </Note>
      </Card>
    );
  }

  if (!status) {
    return (
      <Card {...head}>
        {factTiles}
        <p className="flex items-center gap-3 px-3 text-sm text-neutral-700"><Loader2 size={16} className="animate-spin" /> Reading the old sender</p>
      </Card>
    );
  }

  const queueKnown = !!status.queueStatsAt;
  const waiting = status.queueStats.pending + status.queueStats.pushing;
  const shown = showAll ? log : log.slice(0, 8);
  const nothingAtAll = queueKnown && failedJobs.length === 0 && waiting === 0 && log.length === 0;

  return (
    <Card {...head}>
      {factTiles}

      <Tile title="Send now">
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={onDrain}
            disabled={draining || !status.enabled}
            title={!status.enabled ? "The old sender is not running. The reason is written below." : undefined}
            className="btn-secondary"
          >
            {draining ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
            Send what is waiting now
          </button>
          <span className="min-w-0 flex-1 basis-56 text-xs text-neutral-700">
            {!queueKnown
              ? "The queue has not been counted yet, so nothing here says it is empty."
              : waiting > 0
                ? `${waiting} waiting. They are picked up by themselves every few seconds.`
                : "Nothing is waiting. Anything new is picked up by itself."}
          </span>
        </div>
      </Tile>

      {/* Why the drain is off. Three causes, and the old copy named one of them and pointed at a file that no longer ships. */}
      {!status.enabled && (
        <Note tone="warn" icon={AlertTriangle}>
          <p className="font-medium">The old sender is not running, so vouchers waiting in the old queue stay there.</p>
          <p>This usually means one of three things:</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>It has been switched off on this computer.</li>
            <li>This computer is a practice machine, and a practice machine never sends from the real queue.</li>
            <li>This computer cannot reach the online database.</li>
          </ul>
          <p>Ask whoever looks after this computer to check, then close this app and open it again.</p>
        </Note>
      )}

      {nothingAtAll && (
        <Tile><EmptyNote icon={Activity}>Nothing has been sent from this computer yet.</EmptyNote></Tile>
      )}

      {/* 1: what needs a person */}
      {failedJobs.length > 0 && (
        <Tile title={<span className="text-danger-700">Needs you: {failedJobs.length} refused by Tally</span>}>
          <RowList>
            {failedJobs.map((job) => (
              <Row
                key={job.id}
                icon={AlertTriangle}
                tone="danger"
                title={String((job.payload as { voucherType?: string })?.voucherType ?? "Voucher")}
                subject={String((job.payload as { partyLedgerName?: string })?.partyLedgerName ?? "")}
                meta={`Tried ${job.attempts} time${job.attempts === 1 ? "" : "s"}. Queued ${fmtTime(job.created_at)}.`}
                error={job.last_error}
                action={
                  <button onClick={() => onRequeue(job.id)} disabled={requeueingId === job.id} className="btn-secondary">
                    {requeueingId === job.id ? <Loader2 size={16} className="animate-spin" /> : <RotateCcw size={16} />}
                    Try again
                  </button>
                }
              />
            ))}
          </RowList>
        </Tile>
      )}

      {/* 2: what already went */}
      {log.length > 0 && (
        <Tile title="Recently sent">
          <RowList>
            {shown.map((row) => (
              <Row
                key={row.id}
                icon={row.status === "succeeded" ? CheckCircle2 : AlertTriangle}
                tone={row.status === "succeeded" ? "success" : "danger"}
                title={row.voucher_type || "Voucher"}
                subject={row.party}
                meta={[row.date, fmtTime(row.resolved_at), row.tally_vch_id ? `Tally number ${row.tally_vch_id}` : null].filter(Boolean).join(" · ")}
                error={row.status === "failed" ? (row.line_errors?.join(" · ") || row.last_error) : null}
              />
            ))}
          </RowList>
          {log.length > shown.length && (
            <button onClick={() => setShowAll(true)} className="btn-ghost mt-2 w-full">
              Show {log.length - shown.length} more
            </button>
          )}
        </Tile>
      )}

      {status.lastTick && (
        <p className="flex items-center gap-3 px-3 text-xs text-neutral-700">
          <Clock size={16} aria-hidden="true" /> Last checked {fmtTime(status.lastTick)}
          {!status.tallyHealthy && ". Tally was not answering then."}
        </p>
      )}
    </Card>
  );
}

export default PushQueueCard;
