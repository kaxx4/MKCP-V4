/*
 * The office computer's card. After go-live this machine runs in "primary mode": it works the ERP job queue and keeps the cloud copy of Tally up to
 * date. The old push-queue card described a queue nothing uses any more; this one answers the questions an owner actually has:
 *
 *   Is it on?  Is it the right company?  Does the online database know this computer?  When did it last take a job?  When did it last copy
 *   Tally to the cloud?  And if something is not ready, why, in words a person can act on.
 *
 * Every sentence is built in status/primaryFacts.ts. Nothing here reads a setting name or a file name to the owner. When the agent says something
 * that has no plain sentence yet, the card shows a safe sentence and keeps the agent's own words behind "Show the agent's exact words".
 * A reading that has not been made is "not known yet" or "not checked yet", never a green tick.
 */
import { useState } from "react";
import {
  AlertTriangle, Building2, CheckCircle2, Clock, CloudOff, Copy, KeyRound, Loader2, Power, RefreshCw, ShieldCheck, Workflow,
} from "lucide-react";
import { StatusRow, RowGroupHeading, type RowTone } from "./StatusRow";
import {
  plainClaimNote, plainMirrorNote, plainPreflightLine, plainStop, pinSentence, registeredSentence, whenText,
  type PrimarySummaryLike,
} from "../status/primaryFacts";

interface Props {
  /** `null` means THIS APP'S OWN server did not answer. */
  summary: PrimarySummaryLike | null;
  /** The server address, for the one sentence that names it. */
  baseLabel: string;
  onRefresh: () => void;
  refreshing: boolean;
  /** Called with the fingerprint when the person asks to copy it. */
  onCopy: (text: string) => void;
  now?: Date;
}

const toneOf = (t: "good" | "bad" | "unknown"): RowTone => (t === "good" ? "success" : t === "bad" ? "danger" : "warn");

export function PrimaryCard({ summary, baseLabel, onRefresh, refreshing, onCopy, now }: Props) {
  const [showRaw, setShowRaw] = useState(false);
  const at = now ?? new Date();

  if (!summary) {
    return (
      <div className="note note-bad">
        <CloudOff size={16} className="mt-1 shrink-0" />
        <span>
          This app's own server on {baseLabel} is not answering, so the office computer's state cannot be read. Closing and reopening this app is the
          usual fix.
        </span>
      </div>
    );
  }

  const pin = pinSentence(summary, at);
  const reg = registeredSentence(summary);
  const claimNote = plainClaimNote(summary.claim.lastNote);
  const mirrorNote = plainMirrorNote(summary.mirror.lastNote);
  const checks = summary.preflight.lines.map(plainPreflightLine);
  const failing = checks.filter((c) => !c.ok);
  const stops = [
    ...(summary.claim.pausedReason ? [plainStop(summary.claim.pausedReason)] : []),
    ...summary.claim.stoppedBecause.map(plainStop),
  ];
  const startPlain = summary.startProblems.map((p) => plainPreflightLine({ name: "setting", ok: false, detail: p }));
  const anyRaw = failing.some((c) => c.raw) || stops.some((p) => p.raw) || !!pin.raw || !!claimNote?.raw || !!mirrorNote?.raw || startPlain.some((p) => p.raw);

  const headline =
    summary.mode === "on-not-running" ? { tone: "note-bad", text: "Office mode is switched on but could not start. Nothing is being sent to Tally and nothing is being claimed." }
    : summary.preflight.ready === null ? { tone: "note-warn", text: "Office mode is starting. No readiness report has been made yet." }
    : summary.preflight.ready ? { tone: "note-good", text: "The office computer is ready." }
    : { tone: "note-bad", text: `The office computer is not ready: ${failing.length} check${failing.length === 1 ? "" : "s"} not passing. Nothing is sent to Tally until they pass.` };

  return (
    <div className="space-y-4">
      <div className={`note ${headline.tone}`} role="status">
        {headline.tone === "note-good" ? <CheckCircle2 size={16} className="mt-1 shrink-0" /> : <AlertTriangle size={16} className="mt-1 shrink-0" />}
        <span>{headline.text}</span>
      </div>

      {summary.mode === "on-not-running" && startPlain.length > 0 && (
        <section>
          <RowGroupHeading tone="danger" icon={AlertTriangle}>Why it could not start</RowGroupHeading>
          <ul className="tray flex flex-col gap-2">
            {startPlain.map((p, i) => (
              <StatusRow key={i} icon={AlertTriangle} tone="danger" title={p.text} error={showRaw ? p.raw : null} />
            ))}
          </ul>
        </section>
      )}

      {stops.length > 0 && (
        <section>
          <RowGroupHeading tone="warn" icon={AlertTriangle}>Why it is not taking jobs</RowGroupHeading>
          <ul className="tray flex flex-col gap-2">
            {stops.map((p, i) => (
              <StatusRow key={i} icon={AlertTriangle} tone="warn" title={p.text} error={showRaw ? p.raw : null} />
            ))}
          </ul>
        </section>
      )}

      <section>
        <RowGroupHeading>This computer</RowGroupHeading>
        <ul className="tray flex flex-col gap-2">
          <StatusRow
            icon={Power}
            tone={summary.mode === "on" ? "success" : "danger"}
            title="Office mode"
            subject={summary.mode === "on" ? "On" : "On, but not running"}
            meta={summary.machineId ? `This computer is called ${summary.machineId}.` : "This computer has no name in the office system yet."}
          />
          <StatusRow icon={Building2} tone={toneOf(pin.tone)} title="Company check" subject={pin.value} meta={pin.text} error={showRaw ? pin.raw : null} />
          <StatusRow icon={ShieldCheck} tone={toneOf(reg.tone)} title="Known to the online database" subject={reg.value} meta={reg.text} />
          {summary.keyHash && (
            <StatusRow
              icon={KeyRound}
              tone="neutral"
              title="Key fingerprint"
              meta="A short code that identifies this computer's private key. It is safe to share. The key itself never leaves this computer."
              detail={<span className="tabular-nums wrap-anywhere">{summary.keyHash}</span>}
              action={
                <button className="btn-secondary btn-sm" onClick={() => onCopy(summary.keyHash!)}>
                  <Copy size={16} />
                  Copy
                </button>
              }
            />
          )}
          <StatusRow
            icon={Workflow}
            tone={summary.claim.errors > 0 ? "warn" : summary.claim.lastWorkAt ? "success" : "neutral"}
            title="Last job taken"
            subject={summary.claim.lastWorkAt ? whenText(summary.claim.lastWorkAt, at) : "none yet"}
            meta={
              summary.claim.lastLookAt
                ? `It last looked for work ${whenText(summary.claim.lastLookAt, at)}.${claimNote ? ` ${claimNote.text}` : ""}`
                : "It has not looked for work since the program started."
            }
            error={showRaw ? claimNote?.raw ?? null : null}
          />
          <StatusRow
            icon={RefreshCw}
            tone={summary.mirror.errors > 0 || summary.mirror.holds > 0 ? "warn" : summary.mirror.lastWorkAt ? "success" : "neutral"}
            title="Last copy to the cloud"
            subject={summary.mirror.lastWorkAt ? whenText(summary.mirror.lastWorkAt, at) : "none yet"}
            meta={
              summary.mirror.lastLookAt
                ? `It last looked ${whenText(summary.mirror.lastLookAt, at)}.${mirrorNote ? ` ${mirrorNote.text}` : ""}`
                : "It has not looked since the program started."
            }
            detail={
              summary.mirror.holds > 0 || summary.mirror.alarms > 0
                ? `${[summary.mirror.holds > 0 ? `${summary.mirror.holds} thing${summary.mirror.holds === 1 ? " is" : "s are"} being held back` : "", summary.mirror.alarms > 0 ? `${summary.mirror.alarms} warning${summary.mirror.alarms === 1 ? " was" : "s were"} raised` : ""].filter(Boolean).join(" and ")}. The sync history further down says more.`
                : undefined
            }
            error={showRaw ? mirrorNote?.raw ?? null : null}
          />
        </ul>
      </section>

      <section>
        <RowGroupHeading icon={Clock}>
          Readiness checks{summary.preflight.at ? `, reported ${whenText(summary.preflight.at, at)}` : ""}
        </RowGroupHeading>
        {checks.length === 0 ? (
          <p className="rounded-md bg-bg-sub px-4 py-3 text-sm text-neutral-700">
            No readiness report has been made since the program started{summary.preflight.lastError ? ". The last attempt to send one failed" : ""}.
          </p>
        ) : (
          <ul className="tray flex flex-col gap-2">
            {checks.map((c, i) => (
              <StatusRow
                key={i}
                icon={c.ok ? CheckCircle2 : AlertTriangle}
                tone={c.ok ? "success" : "danger"}
                title={c.text}
                error={!c.ok && showRaw ? c.raw : null}
              />
            ))}
          </ul>
        )}
      </section>

      <div className="flex flex-wrap items-center gap-2">
        <button className="btn-secondary" onClick={onRefresh} disabled={refreshing}>
          {refreshing ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
          Read it again
        </button>
        {anyRaw && (
          <button className="btn-ghost" onClick={() => setShowRaw((v) => !v)} aria-pressed={showRaw}>
            {showRaw ? "Hide the agent's exact words" : "Show the agent's exact words"}
          </button>
        )}
        <span className="text-xs text-neutral-600">Read {whenText(summary.at, at)}. This card refreshes by itself every 10 seconds.</span>
      </div>
    </div>
  );
}

export default PrimaryCard;
