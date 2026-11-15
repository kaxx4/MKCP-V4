/*
 * The Quick sync card: the first thing on the window after the version, because it is the thing a person comes here to press.
 * It holds, top to bottom: the three quick syncs (which are also the three AUTOMATIC syncs), what the last run did, the other reads a person can
 * start from Tally (PullButtons), how fresh the data is, and the runs on record (PullHistory).
 *
 * ── What the buttons say, and why ─────────────────────────────────────────
 *
 * `hooks/useScheduledSyncs.ts` runs exactly these three windows on exactly these three intervals (Today every 30 minutes by default, the other two
 * off), so each tile says whether its window also runs by itself and how often. That fact used to live only inside the collapsed Settings card.
 *
 * Four different things disable a button (Tally down, no company set, another sync holding the global lock, this quick sync already running) and
 * a flat grey button says none of them, which turns a two-second fix into a hunt through the log. So ONE reason, the first that applies, is
 * written in a note above the buttons and also travels with each button as its tooltip.
 *
 * The result that needs a person is not a failure. `PullResult.incompleteVoucherIds` lists vouchers Tally answered with fewer lines than it has,
 * still short after the automatic retry: silently wrong rows in the mirror, not a failed sync. It gets its own warning where it cannot be read as
 * success.
 */
import { AlertTriangle, CheckCircle2, Clock, Loader2, RefreshCw } from "lucide-react";
import type { QuickSyncState } from "../store/quickSyncStore";
import { Card, Chip, Note, Row, RowList, Tile, type ChipTone } from "./ui";
import { PullButtons, PullHistory, type PullAction, type SyncHistoryRowLike } from "./PullSyncPanel";

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
  /** Why it is not, when it is not, so the card does not blame TallyPrime for this app's own server being down. */
  notConnectedReason?: string | null;
  /** Company configured in this app. */
  company: string;
  /** Some other sync holds the global lock. */
  otherSyncRunning: boolean;
  onRun: (r: QuickSyncRange) => void;
  /* the other reads, and the history behind them */
  pullActions: PullAction[];
  pullWindows: Array<{ label: string; run: () => void }>;
  pullRunningLabel: string | null;
  pullBusy: boolean;
  history: SyncHistoryRowLike[];
  canReadHistory: boolean;
}

const everyLabel = (m: number) =>
  m <= 0 ? "Runs only when you press it"
  : m < 60 ? `Also runs by itself every ${m} minutes`
  : `Also runs by itself every ${(m / 60).toFixed(m % 60 === 0 ? 0 : 1)} hours`;

export function QuickSyncCard({
  ranges, qsync, connected, notConnectedReason, company, otherSyncRunning, onRun,
  pullActions, pullWindows, pullRunningLabel, pullBusy, history, canReadHistory,
}: Props) {
  /* One reason, the first that applies. */
  const blocked =
    !connected ? (notConnectedReason ?? "Tally is not answering, so there is nothing to pull from.")
    : !company.trim() ? "No company is set in Settings, so there is nothing to sync as."
    : qsync.running ? `The ${qsync.running} sync is running.`
    : otherSyncRunning ? "Another sync is holding the Tally connection."
    : null;
  /* What the manual reads need on their own: the reasons above that are about connecting, not about this quick sync running. */
  const pullBlocked =
    !connected ? (notConnectedReason ?? "Tally is not answering, so there is nothing to pull from.")
    : !company.trim() ? "No company is set in Settings, so there is nothing to sync as."
    : null;

  const tally = qsync.tally;
  const push = qsync.push;
  const incomplete = tally?.incompleteVoucherIds?.length ?? 0;
  const skipped = qsync.lastSkipped && (!qsync.finishedAt || qsync.lastSkipped.at > qsync.finishedAt) ? qsync.lastSkipped : null;

  const headChip: { tone: ChipTone; text: string } =
    qsync.running ? { tone: "info", text: `Running: ${qsync.running}` }
    : qsync.finishedAt ? (qsync.ok ? { tone: "good", text: "Last run worked" } : { tone: "bad", text: "Last run failed" })
    : { tone: "neutral", text: "Not run since this app started" };

  const stepChip = (running: boolean, done: { ok: boolean } | undefined, waiting: string): ReturnType<typeof Chip> =>
    running ? <Chip tone="info">Working</Chip>
    : done ? (done.ok ? <Chip tone="good">Done</Chip> : <Chip tone="bad">Failed</Chip>)
    : <Chip>{waiting}</Chip>;

  return (
    <Card
      icon={RefreshCw}
      title="Quick sync"
      sub="Reads days from Tally one at a time, then sends them to the online database."
      chip={<Chip tone={headChip.tone}>{headChip.text}</Chip>}
    >
      {blocked && (
        <Note tone="warn" icon={AlertTriangle}>
          <p>{blocked}</p>
        </Note>
      )}

      {/* A scheduled run that never happened. Without this the indicator is identical to the scheduler simply not having fired. */}
      {skipped && (
        <Note tone="warn" icon={AlertTriangle}>
          <p>
            The automatic <strong className="font-medium">{skipped.label}</strong> sync was skipped because{" "}
            {skipped.reason === "sync-in-progress" ? "another sync was already running"
              : skipped.reason === "not-connected" ? "Tally was not connected"
              : "no company is set"}
            . It will try again at the next time it is due.
          </p>
        </Note>
      )}

      {/* The three quick syncs. The first is the one pressed most, so it is the one blue button on the card. */}
      <div className="grid gap-2 sm:grid-cols-3">
        {ranges.map((r, i) => {
          const running = qsync.running === r.label;
          return (
            <div key={r.label} className="tile flex flex-col gap-3">
              <div>
                <div className="text-sm font-medium text-neutral-900">{r.label}</div>
                {/* The fact the old panel hid in Settings: whether this window also runs on its own, and how often. */}
                <div className="text-xs text-neutral-700">{everyLabel(r.everyMinutes)}</div>
              </div>
              <button
                onClick={() => onRun(r)}
                disabled={!!blocked}
                aria-label={`Sync ${r.label} now`}
                /* The reason travels with the control, not only with the note above it. */
                title={blocked ?? `Read ${r.label} from Tally, then send it to the online database.`}
                className={i === 0 ? "btn-primary w-full" : "btn-secondary w-full"}
              >
                {running ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
                {running ? (qsync.phase === "push" ? "Sending" : "Reading") : "Sync now"}
              </button>
            </div>
          );
        })}
      </div>
      <p className="px-3 text-xs text-neutral-700">
        The two steps never overlap, so the sending never picks up a half-finished day.
      </p>

      {/* The run itself, in the order it happens. */}
      <Tile
        title={qsync.running ? `Running: ${qsync.running}` : tally ? `Last run${qsync.auto ? " (automatic)" : ""}` : "Last run"}
        aside={qsync.finishedAt && !qsync.running ? `Finished ${new Date(qsync.finishedAt).toLocaleString("en-IN")}` : undefined}
      >
        {tally || qsync.running ? (
          <RowList>
            <Row
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
              chip={stepChip(!!qsync.running && qsync.phase === "sync", tally, "Waiting")}
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
            <Row
              icon={qsync.running && qsync.phase === "push" ? Loader2 : push?.ok ? CheckCircle2 : push ? AlertTriangle : Clock}
              tone={qsync.running && qsync.phase === "push" ? "accent" : push?.ok ? "success" : push ? "danger" : "neutral"}
              spinning={!!qsync.running && qsync.phase === "push"}
              title="Step 2: send to the online database"
              subject={push ? undefined : qsync.phase === "push" ? "sending" : qsync.running ? "waiting for the read to finish" : "not started"}
              chip={stepChip(!!qsync.running && qsync.phase === "push", push, "Waiting")}
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
          </RowList>
        ) : (
          <p className="text-sm text-neutral-700">No quick sync has run since this app started.</p>
        )}

        {/* Neither a failure nor a success. The sync completed; some of what it wrote is short of what Tally holds. */}
        {incomplete > 0 && (
          <Note tone="warn" icon={AlertTriangle} className="mt-3">
            <p className="font-medium">
              {incomplete} voucher{incomplete === 1 ? "" : "s"} came back from Tally with fewer lines than {incomplete === 1 ? "it has" : "they have"}, and {incomplete === 1 ? "was" : "were"} still short after a second try.
            </p>
            <p>
              Every day was read, so the sync says it worked. But {incomplete === 1 ? "that voucher is" : "those vouchers are"} now
              wrong in the copy rather than missing from it. Running this window again is the fix. Tally usually
              answers in full when it is not busy.
            </p>
          </Note>
        )}
      </Tile>

      <PullButtons actions={pullActions} windows={pullWindows} runningLabel={pullRunningLabel} busy={pullBusy} blocked={pullBlocked} />

      <PullHistory history={history} canReadHistory={canReadHistory} />
    </Card>
  );
}

export default QuickSyncCard;
