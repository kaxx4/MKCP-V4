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
 * `text-blue-500`, `text-green-600`, `text-red-600`, `text-amber-700` — five
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
  m <= 0 ? "manual only"
  : m < 60 ? `automatic every ${m} min`
  : `automatic every ${(m / 60).toFixed(m % 60 === 0 ? 0 : 1)} h`;

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
      <p className="text-[12px] text-neutral-600">
        Pulls the window from Tally day by day, then pushes what it pulled to Supabase — never at the same time, so
        the push can never read a half-written day.
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
              title={blocked ?? `Pull ${r.label} from Tally, then push it to Supabase.`}
              className={clsx("btn-secondary btn-sm tap-y !items-start !flex-col !gap-0 !py-1.5")}
            >
              <span className="flex items-center gap-1.5">
                {running ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                {running ? (qsync.phase === "push" ? "Pushing…" : "Pulling…") : r.label}
              </span>
              {/* The fact the old panel hid in Settings: whether this window
                  also runs on its own, and how often. */}
              <span className="text-[10px] font-medium text-neutral-500">{everyLabel(r.everyMinutes)}</span>
            </button>
          );
        })}
      </div>

      {blocked && (
        <p className="flex items-start gap-1.5 text-[11.5px] text-warn-800">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          {blocked}
        </p>
      )}

      {/* A scheduled run that never happened. Without this the indicator is
          identical to the scheduler simply not having fired. */}
      {skipped && (
        <div className="flex items-start gap-2 rounded-xl bg-warn-soft px-3 py-2.5 text-[12px] text-warn-800">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>
            The automatic <strong className="font-semibold">{skipped.label}</strong> sync was skipped —{" "}
            {skipped.reason === "sync-in-progress" ? "another sync was already running"
              : skipped.reason === "not-connected" ? "Tally was not connected"
              : "no company was configured"}
            . It will try again at the next interval.
          </span>
        </div>
      )}

      {/* The run itself, in the order it happens. */}
      {(tally || qsync.running) && (
        <section>
          <RowGroupHeading>
            {qsync.running
              ? `Running — ${qsync.running}`
              : `Last run${qsync.auto ? " (automatic)" : ""}`}
          </RowGroupHeading>
          <ul className="flex flex-col gap-2">
            <StatusRow
              icon={qsync.running && qsync.phase === "sync" ? Loader2 : tally?.ok ? CheckCircle2 : tally ? AlertTriangle : Clock}
              tone={qsync.running && qsync.phase === "sync" ? "accent" : tally?.ok ? "success" : tally ? "danger" : "neutral"}
              spinning={!!qsync.running && qsync.phase === "sync"}
              title="1 · Pull from Tally"
              subject={tally ? undefined : qsync.phase === "sync" ? "reading day by day…" : "not started"}
              meta={
                tally
                  ? `${tally.chunksSucceeded}/${tally.chunksTotal} days${tally.chunksFailed > 0 ? ` · ${tally.chunksFailed} failed` : ""} · ${tally.elapsedSeconds}s`
                  : undefined
              }
              detail={
                tally?.ok ? (
                  <>
                    <strong className="font-semibold text-neutral-900 tabular-nums">{tally.vouchers}</strong> voucher
                    {tally.vouchers === 1 ? "" : "s"} pulled
                    {tally.cleared > 0 && (
                      <>
                        {" · "}
                        <span className="text-warn-800 tabular-nums">{tally.cleared} cleared</span>
                        <span className="text-neutral-500"> (gone from Tally, so removed here too)</span>
                      </>
                    )}
                  </>
                ) : undefined
              }
              error={tally && !tally.ok ? tally.error ?? "The pull failed and gave no reason." : null}
            />

            <StatusRow
              icon={qsync.running && qsync.phase === "push" ? Loader2 : push?.ok ? CheckCircle2 : push ? AlertTriangle : Clock}
              tone={qsync.running && qsync.phase === "push" ? "accent" : push?.ok ? "success" : push ? "danger" : "neutral"}
              spinning={!!qsync.running && qsync.phase === "push"}
              title="2 · Push to Supabase"
              subject={push ? undefined : qsync.phase === "push" ? "writing…" : qsync.running ? "waiting for the pull to finish" : "not started"}
              detail={
                push ? (
                  <span className="tabular-nums">
                    <strong className="font-semibold text-neutral-900">{push.vouchers}</strong> vouchers ·{" "}
                    <strong className="font-semibold text-neutral-900">{push.items}</strong> items ·{" "}
                    <strong className="font-semibold text-neutral-900">{push.ledgers}</strong> ledgers
                  </span>
                ) : undefined
              }
              error={push && !push.ok ? push.vouchersErr || push.configErr || "The push had errors and gave no reason." : null}
            />
          </ul>

          {/* Neither a failure nor a success. The sync completed; some of what
              it wrote is short of what Tally holds. */}
          {incomplete > 0 && (
            <div className="mt-2 flex items-start gap-2 rounded-xl bg-warn-soft px-3 py-2.5 text-[12px] text-warn-800">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <div>
                <p className="font-semibold">
                  {incomplete} voucher{incomplete === 1 ? "" : "s"} came back with fewer lines than {incomplete === 1 ? "it has" : "they have"}, and {incomplete === 1 ? "was" : "were"} still short after the retry.
                </p>
                <p className="mt-1">
                  The sync reports success because every day was fetched — but {incomplete === 1 ? "that voucher is" : "those vouchers are"} now
                  wrong in the mirror rather than missing from it. Re-running this window is the fix; Tally tends to
                  answer fully when it is not busy.
                </p>
              </div>
            </div>
          )}
        </section>
      )}

      {!tally && !qsync.running && (
        <p className="flex items-center gap-1.5 text-[11.5px] text-neutral-500">
          <CloudUpload size={12} /> No quick sync has run since this app started.
        </p>
      )}

      {qsync.finishedAt && !qsync.running && (
        <p className="flex items-center gap-1.5 text-[11px] text-neutral-500">
          <Clock size={11} /> Finished {new Date(qsync.finishedAt).toLocaleString("en-IN")}
        </p>
      )}
    </div>
  );
}

export default QuickSyncPanel;
