/*
 * The Tally card: is TallyPrime answering, which company is open in it, and does that agree with the company this app files figures under.
 *
 * The head says the verdict once, as a chip and one line (from status/agentFacts.ts:tallyFact, shared with Quick View). Below it:
 *
 *   - What needs a person comes first. A company mismatch never stops a sync; it files the figures under the wrong name, which is why it is the
 *     loudest thing here. The card asks Tally directly (`/api/tally/company`, the one route that returns the OPEN company) and compares it with
 *     the configured name. A row that could only ever echo this app's own setting back would never catch that.
 *   - "This app's own server is not answering" is a different failure from Tally being down and has a different fix, so the two never share
 *     advice. With the local server stopped, nothing has been asked of TallyPrime at all.
 *   - Tally's XML port is single-threaded, and an import error freezes it until TallyPrime itself is restarted (dismissing the dialog is not
 *     enough). That is said where the advice for "not answering" is.
 *
 * Tally is asked once, and on demand, never on the 10 s health poll: the port already carries that poll plus every sync.
 */
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Building2, CheckCircle2, Loader2, Plug, RefreshCw, Wifi, WifiOff } from "lucide-react";
import type { AgentFact } from "../status/agentFacts";
import { Card, Chip, Note, Row, RowList, Tile, chipToneOf } from "./ui";

export interface TallyHealthLike {
  connected: boolean;
  tallyUrl: string;
  /** True while a sync holds Tally's port: the health ping is skipped, so `connected` is an inference from the sync, not a fresh answer. */
  busy?: boolean;
  error?: string;
}

interface Props {
  /** `null` means THIS APP'S OWN server did not answer, which is not the same fact as Tally being down. */
  health: TallyHealthLike | null;
  /** The card's verdict, from tallyFact(). */
  fact: AgentFact;
  /** The company this app is configured to sync AS. */
  configuredCompany: string;
  /** Base URL of this app's own local server (not Tally's). */
  base: string;
}

export function TallyCard({ health, fact, configuredCompany, base }: Props) {
  const [openCompany, setOpenCompany] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);

  const askTally = useCallback(async () => {
    setAsking(true);
    setAskError(null);
    try {
      const r = await fetch(`${base}/api/tally/company`);
      const j = await r.json();
      if (j?.success) setOpenCompany(j.current ?? null);
      else setAskError(j?.error || "Tally did not name a company");
    } catch (e: any) {
      setAskError(e.message);
    } finally {
      setAsking(false);
    }
  }, [base]);

  useEffect(() => {
    if (health?.connected) void askTally();
  }, [health?.connected, askTally]);

  const connected = health?.connected ?? false;
  const localServerDown = health == null;
  const baseLabel = base.replace(/^https?:\/\//, "");
  const configured = configuredCompany.trim();
  /* Tally spells the company exactly as it is in the .tsl; a case or whitespace difference is the same company, a different name is not. */
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  const mismatch = !!openCompany && !!configured && norm(openCompany) !== norm(configured);

  return (
    <Card
      icon={connected ? Wifi : WifiOff}
      title="Tally"
      sub={fact.sub}
      chip={<Chip tone={chipToneOf(fact.tone)}>{fact.value}</Chip>}
    >
      {mismatch && (
        <Note tone="bad" icon={AlertTriangle}>
          <p className="font-medium">Tally has a different company open from the one this agent syncs as.</p>
          <p>
            Open in Tally: <strong className="font-medium">{openCompany}</strong>. This agent syncs as:{" "}
            <strong className="font-medium">{configured}</strong>.
          </p>
          <p>
            Nothing will fail. The figures will just be filed under the name in Settings. Either open the right
            company in TallyPrime, or change the company name in Settings below to match.
          </p>
        </Note>
      )}

      {localServerDown && (
        <Note tone="bad" icon={WifiOff}>
          <p className="font-medium">
            This app&rsquo;s own server on <span>{baseLabel}</span> is not answering, so nothing in this window can be read.
          </p>
          <p>
            Nothing here says anything about TallyPrime, because it has not been asked. The usual causes are the app
            being opened before its server was ready, or another copy of this app already running, which the
            Mirror card below names.
          </p>
          <p><strong className="font-medium">Closing this app and opening it again is the usual fix.</strong></p>
        </Note>
      )}

      {!localServerDown && !connected && (
        <Note tone="bad" icon={WifiOff}>
          <p className="font-medium">TallyPrime is not answering, so nothing can be read from it or sent to it.</p>
          {health?.error && <p className="text-xs">{health.error}</p>}
          <ol className="list-decimal space-y-1 pl-5">
            <li>TallyPrime is open and a company is loaded, not sitting on the screen where you choose a company.</li>
            <li>
              Its connection is switched on: press F1, then Settings, then Connectivity, and set TallyPrime to act as
              Server on port 9000.
            </li>
            <li>
              <strong className="font-medium">If Tally showed an error message while receiving something, close TallyPrime completely and open it again.</strong>{" "}
              The error freezes its connection until then. Closing the message is not enough.
            </li>
          </ol>
        </Note>
      )}

      <Tile
        title="Company"
        aside={
          connected ? (
            <button onClick={() => void askTally()} disabled={asking} className="btn-secondary">
              {asking ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
              Check again
            </button>
          ) : undefined
        }
      >
        <RowList>
          <Row
            icon={Building2}
            tone={mismatch ? "danger" : openCompany ? "success" : "neutral"}
            title="Company open in Tally"
            subject={openCompany ?? (connected ? "asking Tally" : "not known")}
            chip={
              mismatch ? <Chip tone="bad">Different</Chip>
              : openCompany ? <Chip tone="good">Matches</Chip>
              : <Chip>{connected ? "Asking" : "Not known"}</Chip>
            }
            meta={
              askError
                ? undefined
                : openCompany
                  ? "Read from Tally itself, not from this app's settings."
                  : connected
                    ? undefined
                    : localServerDown
                      ? "It cannot be read. This app's own server is not answering, so Tally was never asked."
                      : "It cannot be read while Tally is not answering."
            }
            error={askError}
            spinning={asking}
          />
          <Row
            icon={mismatch ? AlertTriangle : CheckCircle2}
            tone={mismatch ? "danger" : configured ? "neutral" : "warn"}
            title="Figures are filed under"
            subject={configured || "not set"}
            chip={configured ? undefined : <Chip tone="warn">Not set</Chip>}
            meta={
              configured
                ? "The company name every figure sent to the online database is filed under."
                : "Set it in Settings, or nothing has a company to belong to."
            }
          />
        </RowList>
      </Tile>

      <Tile title="Where this app is talking">
        <RowList>
          <Row
            icon={Plug}
            tone={localServerDown ? "neutral" : connected ? "success" : "danger"}
            title="Tally's connection"
            subject={health?.tallyUrl ?? "not known"}
            chip={localServerDown ? <Chip>Not asked</Chip> : connected ? <Chip tone="good">Answering</Chip> : <Chip tone="bad">No answer</Chip>}
            meta={
              localServerDown
                ? "Not asked. The request never left this app."
                : health?.busy
                  ? "A sync is using it right now, so this is worked out from the sync and not from a fresh check."
                  : connected
                    ? "It answered the last check."
                    : "No answer."
            }
          />
          <Row
            icon={Plug}
            tone={localServerDown ? "danger" : "neutral"}
            title="This app's server"
            subject={baseLabel}
            chip={<Chip tone={localServerDown ? "bad" : "good"}>{localServerDown ? "Not answering" : "Answering"}</Chip>}
            meta={localServerDown ? "Everything in this window is read through it." : "The only program here that talks to Tally."}
          />
        </RowList>
      </Tile>
    </Card>
  );
}

export default TallyCard;
