/*
 * Quick Sync, rebuilt from 0 on the web dashboard's idiom.
 *
 * ── What was wrong with the old one ───────────────────────────────────────
 *
 * The three buttons never said that they are also the three AUTOMATIC syncs.
 * `hooks/useScheduledSyncs.ts` runs exactly these three windows on exactly
 * these three intervals — Today every 30 minutes by default, the other two off
 * — and the only place that was written down was a paragraph inside the
 * collapsed Settings panel. So the panel showed a "Today" button with no hint
 * that Today had already run four times while the operator was at lunch, and
 * "Last 7 days" with no hint that it never runs unless pressed.
 *
 * Its buttons went flat-disabled with no reason given. Four different things
 * disable them — Tally down, no company set, another sync holding the global
 * lock, this quick sync already running — and the button looked identical for
 * all four, which turns a two-second fix into a hunt through the log.
 *
 * Its two phase boxes were hand-built `border border-neutral-200` cards using
 * `text-accent-700`, `text-success-700`, `text-danger-700`, `text-warn-700` — five
 * raw palette colours for the same four states the rest of the app already has
 * semantic tokens for.
 *
 * And it dropped the one result that needs a person. `PullResult` carries
 * `incompleteVoucherIds`: vouchers Tally answered with fewer lines than it has,
 * still short after the automatic retry. Those are silently wrong rows in the
 * mirror, not a failed sync — the old panel rendered a green tick over them.
 *
 * ── What this shows instead ───────────────────────────────────────────────
 *
 * What the button will do and when it does it by itself; why it is disabled
 * when it is; then the run as two ordered steps, with the incomplete-voucher
 * warning where it cannot be mistaken for success.
 */
import {
  AlertTriangle, CheckCircle2, Clock, CloudUpload, Loader2, RefreshCw,
} from "lucide-react";
import clsx from "clsx";
import type { QuickSyncState } from "../store/quickSyncStore";
import { StatusRow, RowGroupHeading } from "./StatusRow";

export interface QuickSyncRange {
  label: string;
  from: string;
  to: string;
  /** Minutes between automatic runs of this exact window; 0 = manual only. */
  everyMinutes: number;
}

interface Props {
  ranges: QuickSyncRange[];
  qsync: QuickSyncState;
  /** Tally reachable right now. */
  connected: boolean;
  /** Why it is not, when it is not — so the panel does not blame TallyPrime for
   *  this app's own server being down. Falls back to the Tally wording. */
  notConnectedReason?: string | null;
  /** Company configured in this app. */
  company: string;
  /** Some other sync holds the global lock. */
  otherSyncRunning: boolean;
  onRun: (r: QuickSyncRange) => void;
}

const everyLabel = (m: number) =>
  m <= 0 ? "only when you press it"
  : m < 60 ? `by itself every ${m} minutes`
  : `by itself every ${(m / 60).toFixed(m % 60 === 0 ? 0 : 1)} hours`;

export function QuickSyncPanel({ ranges, qsync, connected, notConnectedReason, company, otherSyncRunning, onRun }: Props) {
  /* One reason, the first that applies — not a disabled button with no note. */
  const blocked =
    !connected ? (notConnectedReason ?? "Tally is not answering, so there is nothing to pull from.")
    : !company.trim() ? "No company is set in Settings, so there is nothing to sync as."
    : qsync.running ? `The ${qsync.running} sync is running.`
    : otherSyncRunning ? "Another sync is holding the Tally connection."
    : null;

  const tally = qsync.tally;
  const push = qsync.push;
  const incomplete = tally?.incompleteVoucherIds?.length ?? 0;
  const skipped =
    qsync.lastSkipped && (!qsync.finishedAt || qsync.lastSkipped.at > qsync.finishedAt)
      ? qsync.lastSkipped
      : null;

  return (
    <div className="space-y-3">
      <p className="text-sm text-neutral-700">
        Reads the chosen days from Tally one day at a time, then sends them to the online database. The two steps never
        overlap, so the sending never picks up a half-finished day.
      </p>

      <div className="flex flex-wrap gap-2">
        {ranges.map((r) => {
          const running = qsync.running === r.label;
          return (
            <button
              key={r.label}
              onClick={() => onRun(r)}
              disabled={!!blocked}
              /* The reason travels with the control, not only with the note
                 below it — a pointer resting on a grey button should answer
                 the question it just raised. */
              title={blocked ?? `Read ${r.label} from Tally, then send it to the online database.`}
              className={clsx("btn-secondary !flex-col !items-start !gap-0 !rounded-md !py-2")}
            >
              <span className="flex items-center gap-2">
                {running ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
                {running ? (qsync.phase === "push" ? "Sending" : "Reading") : r.label}
              </span>
              {/* The fact the old panel hid in Settings: whether this window
                  also runs on its own, and how often. */}
              <span className="text-xs text-neutral-700">{everyLabel(r.everyMinutes)}</span>
            </button>
          );
        })}
      </div>

      {blocked && (
        <p className="flex items-start gap-2 text-sm text-warn-700">
          <AlertTriangle size={16} className="mt-1 shrink-0" />
          {blocked}
        </p>
      )}

      {/* A scheduled run that never happened. Without this the indicator is
          identical to the scheduler simply not having fired. */}
      {skipped && (
        <div className="note note-warn">
          <AlertTriangle size={16} className="mt-1 shrink-0" />
          <span>
            The automatic <strong className="font-medium">{skipped.label}</strong> sync was skipped because{" "}
            {skipped.reason === "sync-in-progress" ? "another sync was already running"
              : skipped.reason === "not-connected" ? "Tally was not connected"
              : "no company is set"}
            . It will try again at the next time it is due.
          </span>
        </div>
      )}

      {/* The run itself, in the order it happens. */}
      {(tally || qsync.running) && (
        <section>
          <RowGroupHeading>
            {qsync.running
              ? `Running: ${qsync.running}`
              : `Last run${qsync.auto ? " (automatic)" : ""}`}
          </RowGroupHeading>
          <ul className="tray flex flex-col gap-2">
            <StatusRow
              icon={qsync.running && qsync.phase === "sync" ? Loader2 : tally?.ok ? CheckCircle2 : tally ? AlertTriangle : Clock}
              tone={qsync.running && qsync.phase === "sync" ? "accent" : tally?.ok ? "success" : tally ? "danger" : "neutral"}
              spinning={!!qsync.running && qsync.phase === "sync"}
              title="Step 1: read from Tally"
              subject={tally ? undefined : qsync.phase === "sync" ? "reading one day at a time" : "not started"}
              meta={
                tally
                  ? `${tally.chunksSucceeded} of ${tally.chunksTotal} days read${tally.chunksFailed > 0 ? `, ${tally.chunksFailed} failed` : ""}, in ${tally.elapsedSeconds} seconds`
                  : undefined
              }
              detail={
                tally?.ok ? (
                  <>
                    <strong className="font-medium text-neutral-900 tabular-nums">{tally.vouchers}</strong> voucher
                    {tally.vouchers === 1 ? "" : "s"} read
                    {tally.cleared > 0 && (
                      <>
                        {". "}
                        <span className="text-warn-700 tabular-nums">{tally.cleared} removed</span>
                        <span className="text-neutral-700"> (they are gone from Tally, so they are removed here too)</span>
                      </>
                    )}
                  </>
                ) : undefined
              }
              error={tally && !tally.ok ? tally.error ?? "The read from Tally failed and gave no reason." : null}
            />

            <StatusRow
              icon={qsync.running && qsync.phase === "push" ? Loader2 : push?.ok ? CheckCircle2 : push ? AlertTriangle : Clock}
              tone={qsync.running && qsync.phase === "push" ? "accent" : push?.ok ? "success" : push ? "danger" : "neutral"}
              spinning={!!qsync.running && qsync.phase === "push"}
              title="Step 2: send to the online database"
              subject={push ? undefined : qsync.phase === "push" ? "sending" : qsync.running ? "waiting for the read to finish" : "not started"}
              detail={
                push ? (
                  <span className="tabular-nums">
                    <strong className="font-medium text-neutral-900">{push.vouchers}</strong> vouchers,{" "}
                    <strong className="font-medium text-neutral-900">{push.items}</strong> items and{" "}
                    <strong className="font-medium text-neutral-900">{push.ledgers}</strong> parties sent
                  </span>
                ) : undefined
              }
              error={push && !push.ok ? push.vouchersErr || push.configErr || "The send had errors and gave no reason." : null}
            />
          </ul>

          {/* Neither a failure nor a success. The sync completed; some of what
              it wrote is short of what Tally holds. */}
          {incomplete > 0 && (
            <div className="mt-2 note note-warn">
              <AlertTriangle size={16} className="mt-1 shrink-0" />
              <div>
                <p className="font-medium">
                  {incomplete} voucher{incomplete === 1 ? "" : "s"} came back from Tally with fewer lines than {incomplete === 1 ? "it has" : "they have"}, and {incomplete === 1 ? "was" : "were"} still short after a second try.
                </p>
                <p className="mt-1">
                  Every day was read, so the sync says it worked. But {incomplete === 1 ? "that voucher is" : "those vouchers are"} now
                  wrong in the copy rather than missing from it. Running this window again is the fix. Tally usually
                  answers in full when it is not busy.
                </p>
              </div>
            </div>
          )}
        </section>
      )}

      {!tally && !qsync.running && (
        <p className="flex items-center gap-2 text-xs text-neutral-700">
          <CloudUpload size={16} /> No quick sync has run since this app started.
        </p>
      )}

      {qsync.finishedAt && !qsync.running && (
        <p className="flex items-center gap-2 text-xs text-neutral-700">
          <Clock size={16} /> Finished {new Date(qsync.finishedAt).toLocaleString("en-IN")}
        </p>
      )}
    </div>
  );
}

export default QuickSyncPanel;
