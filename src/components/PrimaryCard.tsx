/*
 * The office computer's card. After go-live this machine runs in "primary mode": it works the ERP job queue and keeps the cloud copy of Tally up to
 * date. The old push-queue card described a queue nothing uses any more; this one answers the questions an owner actually has:
 *
 *   Is it on?  Is it the right company?  Does the online database know this computer?  When did it last take a job?  When did it last copy
 *   Tally to the cloud?  And if something is not ready, why, in words a person can act on.
 *
 * It opens with the three readings (is it ready, last job, last copy to the cloud; status/primaryFacts.ts), then the detail behind them.
 * Every sentence is built in status/primaryFacts.ts. Nothing here reads a setting name or a file name to the owner. When the agent says something
 * that has no plain sentence yet, the card shows a safe sentence and keeps the agent's own words behind "Show the agent's exact words".
 * A reading that has not been made is "not known yet" or "not checked yet", never a green tick.
 */
import { useState } from "react";
import {
  AlertTriangle, Building2, CheckCircle2, Clock, CloudOff, Copy, KeyRound, Loader2, Power, RefreshCw, ShieldCheck, Workflow,
} from "lucide-react";
import type { AgentFact } from "../status/agentFacts";
import { Card, Chip, Fact, Note, Row, RowList, Tile, type RowTone } from "./ui";
import {
  plainClaimNote, plainMirrorNote, plainPreflightLine, plainStop, pinSentence, registeredSentence, whenText,
  type PrimarySummaryLike,
} from "../status/primaryFacts";

interface Props {
  /** `null` means THIS APP'S OWN server did not answer. */
  summary: PrimarySummaryLike | null;
  /** The three readings, from officeFact(), claimFact() and mirrorRunFact(). */
  facts: AgentFact[];
  /** The server address, for the one sentence that names it. */
  baseLabel: string;
  onRefresh: () => void;
  refreshing: boolean;
  /** Called with the fingerprint when the person asks to copy it. */
  onCopy: (text: string) => void;
  now?: Date;
}

const toneOf = (t: "good" | "bad" | "unknown"): RowTone => (t === "good" ? "success" : t === "bad" ? "danger" : "warn");
const chipOf = (t: "good" | "bad" | "unknown") => (t === "good" ? "good" : t === "bad" ? "bad" : "neutral") as "good" | "bad" | "neutral";

export function PrimaryCard({ summary, facts, baseLabel, onRefresh, refreshing, onCopy, now }: Props) {
  const [showRaw, setShowRaw] = useState(false);
  const at = now ?? new Date();

  const head = { icon: Building2, title: "Office computer", sub: "Takes jobs from the online database for Tally, and keeps the online copy of Tally up to date." };
  const factTiles = <div className="grid gap-2 sm:grid-cols-3">{facts.map((f) => <Fact key={f.label} fact={f} />)}</div>;

  if (!summary) {
    return (
      <Card {...head}>
        {factTiles}
        <Note tone="bad" icon={CloudOff}>
          <p>
            This app's own server on {baseLabel} is not answering, so the office computer's state cannot be read. Closing and reopening this app is the
            usual fix.
          </p>
        </Note>
      </Card>
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

  const headline: { tone: "bad" | "warn" | "good"; text: string } =
    summary.mode === "on-not-running" ? { tone: "bad", text: "Office mode is switched on but could not start. Nothing is being sent to Tally and nothing is being claimed." }
    : summary.preflight.ready === null ? { tone: "warn", text: "Office mode is starting. No readiness report has been made yet." }
    : summary.preflight.ready ? { tone: "good", text: "The office computer is ready." }
    : { tone: "bad", text: `The office computer is not ready: ${failing.length} check${failing.length === 1 ? "" : "s"} not passing. Nothing is sent to Tally until they pass.` };

  return (
    <Card {...head}>
      {factTiles}

      <Note tone={headline.tone} icon={headline.tone === "good" ? CheckCircle2 : AlertTriangle} role="status">
        <p>{headline.text}</p>
      </Note>

      {summary.mode === "on-not-running" && startPlain.length > 0 && (
        <Tile title={<span className="text-danger-700">Why it could not start</span>}>
          <RowList>
            {startPlain.map((p, i) => (
              <Row key={i} icon={AlertTriangle} tone="danger" title={p.text} error={showRaw ? p.raw : null} />
            ))}
          </RowList>
        </Tile>
      )}

      {stops.length > 0 && (
        <Tile title={<span className="text-warn-700">Why it is not taking jobs</span>}>
          <RowList>
            {stops.map((p, i) => (
              <Row key={i} icon={AlertTriangle} tone="warn" title={p.text} error={showRaw ? p.raw : null} />
            ))}
          </RowList>
        </Tile>
      )}

      <Tile title="This computer">
        <RowList>
          <Row
            icon={Power}
            tone={summary.mode === "on" ? "success" : "danger"}
            title="Office mode"
            chip={<Chip tone={summary.mode === "on" ? "good" : "bad"}>{summary.mode === "on" ? "On" : "On, but not running"}</Chip>}
            meta={summary.machineId ? `This computer is called ${summary.machineId}.` : "This computer has no name in the office system yet."}
          />
          <Row icon={Building2} tone={toneOf(pin.tone)} title="Company check" chip={<Chip tone={chipOf(pin.tone)}>{pin.value}</Chip>} meta={pin.text} error={showRaw ? pin.raw : null} />
          <Row icon={ShieldCheck} tone={toneOf(reg.tone)} title="Known to the online database" chip={<Chip tone={chipOf(reg.tone)}>{reg.value}</Chip>} meta={reg.text} />
          {summary.keyHash && (
            <Row
              icon={KeyRound}
              title="Key fingerprint"
              meta="A short code that identifies this computer's private key. It is safe to share. The key itself never leaves this computer."
              detail={<span className="tabular-nums">{summary.keyHash}</span>}
              action={
                <button className="btn-secondary" onClick={() => onCopy(summary.keyHash!)}>
                  <Copy size={16} />
                  Copy
                </button>
              }
            />
          )}
          <Row
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
          <Row
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
        </RowList>
      </Tile>

      <Tile title="Readiness checks" aside={summary.preflight.at ? `reported ${whenText(summary.preflight.at, at)}` : undefined}>
        {checks.length === 0 ? (
          <p className="flex items-center gap-3 text-sm text-neutral-700">
            <Clock size={16} className="shrink-0 text-neutral-600" aria-hidden="true" />
            No readiness report has been made since the program started{summary.preflight.lastError ? ". The last attempt to send one failed" : ""}.
          </p>
        ) : (
          <RowList>
            {checks.map((c, i) => (
              <Row
                key={i}
                icon={c.ok ? CheckCircle2 : AlertTriangle}
                tone={c.ok ? "success" : "danger"}
                title={c.text}
                chip={<Chip tone={c.ok ? "good" : "bad"}>{c.ok ? "Passing" : "Not passing"}</Chip>}
                error={!c.ok && showRaw ? c.raw : null}
              />
            ))}
          </RowList>
        )}
      </Tile>

      <div className="flex flex-wrap items-center gap-3 px-3">
        <button className="btn-secondary" onClick={onRefresh} disabled={refreshing}>
          {refreshing ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
          Read it again
        </button>
        {anyRaw && (
          <button className="btn-ghost" onClick={() => setShowRaw((v) => !v)} aria-pressed={showRaw}>
            {showRaw ? "Hide the agent's exact words" : "Show the agent's exact words"}
          </button>
        )}
        <span className="text-xs text-neutral-700">Read {whenText(summary.at, at)}. This card refreshes by itself every 10 seconds.</span>
      </div>
    </Card>
  );
}

export default PrimaryCard;
