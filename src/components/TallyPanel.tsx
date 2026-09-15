/*
 * Tally, rebuilt from 0 on the web dashboard's idiom.
 *
 * ── What was wrong with the old one ───────────────────────────────────────
 *
 * It repeated the header. The KPI strip at the top of the page already says
 * "Tally — Connected" with the URL underneath; this panel's first line was a
 * green "Connected" pill and its second line was the same URL. Three rows of
 * label/value, two of which the reader had already read.
 *
 * Its one remaining row LIED. `<Row label="Company" value={health?.current ||
 * company} />` reads as "the company Tally has open", and the reader takes it
 * that way — but `/api/tally/health` never returns `current` (see
 * server/src/index.ts: it answers `{connected, tallyUrl}` and nothing else), so
 * the fallback fired every single time and the row was always just this app's
 * OWN configured company name, echoed back. A row that can only ever agree with
 * itself cannot catch the one failure it looks like it is there to catch: the
 * agent syncing under a company key that is not the company Tally has open.
 * That collision is not hypothetical here — sandbox and production share a
 * company name and write the same Supabase rows.
 *
 * And it was painted in raw palette utilities (`bg-green-50`, `bg-red-50`
 * through the shared `Pill`), so "Tally is down" was a different red from
 * "this voucher failed" a few inches below it.
 *
 * ── What this shows instead ───────────────────────────────────────────────
 *
 * The panel asks Tally directly — `/api/tally/company`, the one route that
 * actually returns the open company — and compares it with what this app is
 * configured to sync as. Agreement is a quiet row; disagreement is the loudest
 * thing on the panel, because it is the failure that silently corrupts the
 * mirror rather than stopping it.
 *
 * Below that: the error, in full, with the checks that are currently true. Two
 * of them are things only this codebase knows — Tally's XML port is
 * single-threaded, and an import error freezes it until TallyPrime itself is
 * restarted (dismissing the dialog is not enough).
 */
import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle, Building2, CheckCircle2, Loader2, Plug, RefreshCw, WifiOff,
} from "lucide-react";
import { StatusRow, RowGroupHeading } from "./StatusRow";

export interface TallyHealthLike {
  connected: boolean;
  tallyUrl: string;
  /** True while a sync holds Tally's port — the health ping is skipped, so
   *  `connected` is an inference from the sync, not a fresh answer. */
  busy?: boolean;
  error?: string;
}

interface Props {
  /** `null` means THIS APP'S OWN server did not answer — which is not the same
   *  fact as Tally being down, and has a different fix. */
  health: TallyHealthLike | null;
  /** The company this app is configured to sync AS. */
  configuredCompany: string;
  /** Base URL of this app's own local server (not Tally's). */
  base: string;
}

export function TallyPanel({ health, configuredCompany, base }: Props) {
  const [openCompany, setOpenCompany] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);

  /* Asked once, and on demand — never on the 10s health poll. Tally's XML port
     is single-threaded and already carries that poll plus every sync; a second
     standing poll against it buys one rarely-changing string and costs the
     queue behind it. */
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
  /* Two processes can be missing and only one of them is TallyPrime. Until
     15-Sep-2026 this panel printed the same "TallyPrime is not answering"
     advice — check the XML port, restart TallyPrime — in both cases, which
     sends the reader into Tally's connectivity settings for a problem that is
     in this app. Observed with the local server stopped: the whole page
     blamed port 9000 while nothing had ever reached port 3100. */
  const localServerDown = health == null;
  const configured = configuredCompany.trim();
  /* Tally spells the company exactly as it is in the .tsl; a case or
     whitespace difference is the same company, a different name is not. */
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  const mismatch = !!openCompany && !!configured && norm(openCompany) !== norm(configured);

  return (
    <div className="space-y-3">
      {/* 1 — what needs a person. A name mismatch never stops a sync; it just
             files the data under the wrong company. */}
      {mismatch && (
        <div className="flex items-start gap-2 rounded-xl bg-danger-soft px-3 py-2.5 text-[12px] text-danger-700">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <div>
            <p className="font-semibold">Tally has a different company open from the one this agent syncs as.</p>
            <p className="mt-1">
              Tally: <strong className="font-semibold">{openCompany}</strong> · this agent:{" "}
              <strong className="font-semibold">{configured}</strong>
            </p>
            <p className="mt-1">
              Nothing will fail — the rows will just be written under the configured name. Either open the right
              company in TallyPrime, or change the company in Settings below to match.
            </p>
          </div>
        </div>
      )}

      {localServerDown && (
        <div className="flex items-start gap-2 rounded-xl bg-danger-soft px-3 py-2.5 text-[12px] text-danger-700">
          <WifiOff size={14} className="mt-0.5 shrink-0" />
          <div>
            <p className="font-semibold">
              This app&rsquo;s own server on <span className="font-mono">{base.replace(/^https?:\/\//, "")}</span> is
              not answering, so nothing on this screen can be read.
            </p>
            <p className="mt-1">
              Nothing here is a statement about TallyPrime — it has not been asked. The usual causes are the app
              being started before its server finished binding, or another copy already holding the port, which the
              mirror panel below reports by name.
            </p>
            <p className="mt-1"><strong>Quitting and reopening this app is the usual fix.</strong></p>
          </div>
        </div>
      )}

      {!localServerDown && !connected && (
        <div className="flex items-start gap-2 rounded-xl bg-danger-soft px-3 py-2.5 text-[12px] text-danger-700">
          <WifiOff size={14} className="mt-0.5 shrink-0" />
          <div>
            <p className="font-semibold">TallyPrime is not answering, so nothing can be pulled or pushed.</p>
            {health?.error && <p className="mt-1 break-words font-mono text-[11px]">{health.error}</p>}
            <ul className="mt-1.5 space-y-0.5">
              <li>· TallyPrime is open, with a company loaded — not sitting on the company-select screen.</li>
              <li>
                · Its XML port is on: <span className="font-mono">F1 → Settings → Connectivity</span>, TallyPrime
                acting as <span className="font-mono">Server</span>, port <span className="font-mono">9000</span>.
              </li>
              <li>
                · <strong>If Tally showed an import error, restart TallyPrime itself.</strong> An XML error freezes
                its server for good; dismissing the dialog does not release the port.
              </li>
            </ul>
          </div>
        </div>
      )}

      {/* 2 — the identity, once it is not a problem */}
      <section>
        <RowGroupHeading>Company</RowGroupHeading>
        <ul className="flex flex-col gap-2">
          <StatusRow
            icon={Building2}
            tone={mismatch ? "danger" : openCompany ? "success" : "neutral"}
            title="Open in Tally"
            subject={openCompany ?? (connected ? "asking Tally…" : "—")}
            meta={
              askError
                ? undefined
                : openCompany
                  ? "read from Tally, not from this app's settings"
                  : connected
                    ? undefined
                    : localServerDown
                      ? "cannot be read — this app's own server is not answering, so Tally was never asked"
                      : "cannot be read while Tally is unreachable"
            }
            error={askError}
            spinning={asking}
            action={
              connected ? (
                <button onClick={() => void askTally()} disabled={asking} className="btn-secondary btn-sm tap-y">
                  {asking ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                  Re-check
                </button>
              ) : undefined
            }
          />
          <StatusRow
            icon={mismatch ? AlertTriangle : CheckCircle2}
            tone={mismatch ? "danger" : configured ? "neutral" : "warn"}
            title="Synced as"
            subject={configured || "not set"}
            meta={
              configured
                ? "the company key every row is written under"
                : "set it in Settings, or nothing has a company to belong to"
            }
          />
        </ul>
      </section>

      {/* 3 — where it is talking, for when someone has two copies running */}
      <section>
        <RowGroupHeading>Endpoints</RowGroupHeading>
        <ul className="flex flex-col gap-2">
          <StatusRow
            icon={Plug}
            title="Tally XML port"
            subject={<span className="font-mono">{health?.tallyUrl ?? "—"}</span>}
            meta={
              localServerDown
                ? "not asked — the request never left this app"
                : health?.busy
                  ? "a sync is holding the port — this is inferred from the sync, not a fresh ping"
                  : connected
                    ? "answered the last health ping"
                    : "no answer"
            }
            tone={localServerDown ? "neutral" : connected ? "success" : "danger"}
          />
          <StatusRow
            icon={Plug}
            tone={localServerDown ? "danger" : "neutral"}
            title="This app's server"
            subject={<span className="font-mono">{base.replace(/^https?:\/\//, "")}</span>}
            meta={
              localServerDown
                ? "not answering — every reading above and below comes through it"
                : "the only process here that talks to Tally"
            }
          />
        </ul>
      </section>
    </div>
  );
}

export default TallyPanel;
