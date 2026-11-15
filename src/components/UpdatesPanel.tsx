/*
 * Updates, at the top of the window: which version this computer runs, whether a newer one exists, and getting from one to the other.
 * This is the only copy. It replaces the small chip that used to sit in the header and the long panel that used to sit at the very bottom, and
 * it keeps what each of them knew.
 *
 * ── The two paths, kept apart on purpose ──────────────────────────────────
 *
 * `electron-updater` answers one question: is there something newer than me on the LATEST release? It cannot show history or go back a version,
 * and the day you want that is the day an update misbehaved on the office machine and the previous one is needed before trading starts. So:
 *
 *   - "Install and restart" and "Update now" use the real OTA path: download in the background, install on restart. They refuse while a voucher
 *     is being sent to Tally, because this process owns Tally's single-threaded XML port and the push drain, and quitting mid-send abandons a
 *     voucher the queue believes is in flight (see `installNow` in autoUpdate.js). "Install anyway" is offered only after that refusal has
 *     actually happened: shown up front it invites the very thing the refusal exists to prevent.
 *
 *   - "Download" on any row of "Published versions" fetches that version's installer and shows it in Explorer. It never runs it. Running an
 *     installer is the person's act, taken where Windows can say what is about to run.
 *
 * Release notes come from GitHub and are written outside this app, so they are shown as TEXT, never as markup. A version whose installer was
 * removed says "no installer" on its row instead of offering a Download that can only fail.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Download, ExternalLink, Loader2, PackageCheck, RefreshCw, Rocket } from "lucide-react";
import { Card, Chip, Disclosure, Note, Tile, type ChipTone } from "./ui";

interface ReleaseRow {
  version: string;
  name: string;
  publishedAt: string | null;
  prerelease: boolean;
  notes: string;
  /** null when the release has no installer attached. */
  exeName: string | null;
  sizeBytes: number;
  htmlUrl: string;
}

interface UpdateState {
  phase?: "idle" | "checking" | "downloading" | "ready" | "current" | "error" | "disabled" | "installing";
  version?: string;
  percent?: number;
  message?: string;
  notes?: string | null;
  releaseName?: string | null;
  releaseDate?: string | null;
}

type Api = {
  getVersion?: () => Promise<string>;
  update?: {
    getState?: () => Promise<UpdateState>;
    checkNow?: () => Promise<UpdateState>;
    installNow?: (o?: { force?: boolean }) => Promise<{ ok: boolean; reason?: string }>;
    listReleases?: (o?: { force?: boolean }) => Promise<{ ok: boolean; rows?: ReleaseRow[]; reason?: string }>;
    downloadRelease?: (v: string) => Promise<{ ok: boolean; path?: string; reason?: string; alreadyHad?: boolean }>;
    onDownloadProgress?: (cb: (p: { version: string; percent: number }) => void) => () => void;
    onState?: (cb: (s: UpdateState) => void) => () => void;
  };
};

const api = (): Api | null =>
  (typeof window !== "undefined" ? ((window as unknown as { electronAPI?: Api }).electronAPI ?? null) : null);

const MB = (b: number) => (b ? `${(b / 1_048_576).toFixed(1)} MB` : "");
const day = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "";

/** Numeric compare, so 1.5.10 sorts above 1.5.9, which a string compare does not. */
function cmp(a: string, b: string): number {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

const BUSY_REFUSAL = "A voucher is being sent to Tally right now. Installing would cut it off halfway.";

export function UpdatesCard({ currentVersion }: { currentVersion?: string }) {
  const installed = currentVersion ?? null;
  const [rows, setRows] = useState<ReleaseRow[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [state, setState] = useState<UpdateState>({});
  const [busyVersion, setBusyVersion] = useState<string | null>(null);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [note, setNote] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [openNotes, setOpenNotes] = useState<string | null>(null);

  const load = useCallback(async (force = false) => {
    const a = api();
    if (!a?.update?.listReleases) { setLoading(false); setListError("Not running in the desktop app."); return; }
    setLoading(true);
    const res = await a.update.listReleases({ force });
    /* "could not ask" and "nothing published" are different facts and an empty list shows them identically, so the reason is kept and shown. */
    if (!res.ok) { setListError(res.reason ?? "Could not reach GitHub."); setRows([]); }
    else { setListError(null); setRows(res.rows ?? []); }
    setLoading(false);
  }, []);

  useEffect(() => {
    const a = api();
    a?.update?.getState?.().then(setState).catch(() => {});
    void load();
    const offState = a?.update?.onState?.(setState);
    const offProg = a?.update?.onDownloadProgress?.((p) => setProgress((prev) => ({ ...prev, [p.version]: p.percent })));
    return () => { offState?.(); offProg?.(); };
  }, [load]);

  const latest = rows[0];
  const behind = installed && latest ? cmp(latest.version, installed) > 0 : false;
  const phase = state.phase;
  const bridge = !!api()?.update;

  const check = async () => {
    setNote(null);
    setRefusal(null);
    await api()?.update?.checkNow?.();
    void load(true);
  };

  /* Refuses while a voucher is being sent unless the person overrules it, and says so in words. */
  async function install(force: boolean) {
    setWorking(true);
    setRefusal(null);
    try {
      const r = await api()?.update?.installNow?.({ force });
      if (r && !r.ok) setRefusal(r.reason === "busy" ? BUSY_REFUSAL : `The install could not be started: ${r.reason}`);
    } catch (e) {
      setRefusal(e instanceof Error ? e.message : "The install could not be started.");
    } finally {
      setWorking(false);
    }
  }

  const updateNow = async () => {
    setNote(null);
    await api()?.update?.checkNow?.();
    setNote("Checking. An update downloads in the background, then this says it is ready.");
  };

  const download = async (v: string) => {
    const a = api();
    if (!a?.update?.downloadRelease) return;
    setBusyVersion(v); setNote(null);
    const res = await a.update.downloadRelease(v);
    setBusyVersion(null);
    setProgress((p) => ({ ...p, [v]: 0 }));
    setNote(res.ok
      ? `${v} ${res.alreadyHad ? "was already in" : "saved to"} Downloads. Shown in Explorer. Run it to install.`
      : `Could not download ${v}: ${res.reason}`);
  };

  const chip: { tone: ChipTone; text: string } =
    phase === "ready" ? { tone: "good", text: state.version ? `Version ${state.version} ready` : "Update ready" }
    : phase === "downloading" ? { tone: "info", text: `Downloading${typeof state.percent === "number" ? ` ${state.percent}%` : ""}` }
    : phase === "installing" ? { tone: "info", text: "Restarting" }
    : phase === "checking" ? { tone: "info", text: "Checking" }
    : phase === "current" ? { tone: "good", text: "Up to date" }
    : phase === "error" ? { tone: "warn", text: "Check failed" }
    : phase === "disabled" ? { tone: "neutral", text: "Not checking" }
    : behind ? { tone: "warn", text: `Version ${latest?.version} is published` }
    : { tone: "neutral", text: "Not checked yet" };

  const statusLine = useMemo(() => {
    switch (phase) {
      case "checking": return "Checking for updates.";
      case "downloading": return `Downloading ${state.version ?? "the update"}: ${state.percent ?? 0}% done.`;
      case "ready": return `${state.version ?? "The update"} is downloaded. It installs on its own when you next close the app.`;
      case "installing": return "Restarting to install.";
      case "current": return "This is the newest published version.";
      case "error": return `The update check failed: ${state.message}`;
      case "disabled": return state.message ?? "This version does not check for updates.";
      default:
        return !bridge ? "Only the installed desktop app can check for updates."
          : behind ? `${latest?.version} is published. Press Update now to fetch it.`
          : "Press Check for update to look for a newer version.";
    }
  }, [phase, state.version, state.percent, state.message, bridge, behind, latest?.version]);

  const checking = loading || phase === "checking";
  const inFlight = phase === "downloading" || phase === "installing";
  const notesText = state.notes ? state.notes.replace(/<[^>]+>/g, "").trim() : "";
  const showDetail = phase === "ready" && !!(notesText || state.message || state.releaseDate);

  const actions = (
    <>
      <button
        onClick={() => void check()}
        disabled={!bridge || checking || inFlight}
        className="btn-secondary"
        title={bridge ? "Look for a newer version now" : "Only the installed desktop app can check for updates."}
      >
        <RefreshCw size={16} className={checking ? "animate-spin" : ""} />
        Check for update
      </button>
      {phase === "ready" ? (
        <button onClick={() => void install(false)} disabled={working} className="btn-primary" title="Closes the agent, installs, and starts it again.">
          {working ? <Loader2 size={16} className="animate-spin" /> : <Rocket size={16} />}
          {working ? "Starting" : "Install and restart"}
        </button>
      ) : behind && !inFlight ? (
        <button onClick={() => void updateNow()} className="btn-primary" title="Download the newer version in the background.">
          <Rocket size={16} />
          Update now
        </button>
      ) : null}
    </>
  );

  return (
    <Card icon={PackageCheck} title="Updates" sub={statusLine} chip={<Chip tone={chip.tone}>{chip.text}</Chip>} actions={actions}>
      {showDetail && (
        <Tile title={`What is in version ${state.version ?? "the update"}`} aside={state.releaseDate ? `published ${day(state.releaseDate)}` : undefined}>
          {/* Text, never markup: release notes are written outside this app. */}
          {notesText
            ? <div className="tile-white max-h-40 overflow-y-auto whitespace-pre-wrap text-sm text-neutral-700">{notesText}</div>
            : state.message ? <p className="text-sm text-neutral-700">{state.message}</p> : null}
        </Tile>
      )}

      {refusal && (
        <Note tone="warn" icon={AlertTriangle} role="alert">
          <p>{refusal}</p>
          {/* The override, offered only once a refusal has actually happened. */}
          {refusal === BUSY_REFUSAL && (
            <div className="pt-2">
              <button onClick={() => void install(true)} disabled={working} className="btn-danger">
                Install anyway, and accept that the voucher may be cut off
              </button>
            </div>
          )}
        </Note>
      )}
      {note && <Note tone="info">{note}</Note>}

      {listError && bridge && (
        <Note tone="warn" icon={AlertTriangle}>
          <p className="font-medium">The list of published versions could not be read.</p>
          {/* An empty list does not mean nothing has been published. */}
          <p>{listError} This means "could not ask", not "nothing has been published".</p>
        </Note>
      )}

      {bridge && !listError && (
        <Disclosure title="Published versions" badge={rows.length ? <Chip plain>{rows.length}</Chip> : undefined}>
          {!loading && rows.length === 0 ? (
            <p className="text-sm text-neutral-700">No versions have been published yet.</p>
          ) : (
            <ul className="row-list">
              {rows.map((r) => {
                const isInstalled = installed === r.version;
                const pct = progress[r.version];
                return (
                  <li key={r.version}>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                      <span className="text-sm font-medium text-neutral-900">{r.version}</span>
                      {isInstalled && <Chip tone="good">installed</Chip>}
                      {r === latest && !isInstalled && <Chip tone="info">newest</Chip>}
                      {r.prerelease && <Chip tone="warn">test version</Chip>}
                      <span className="text-xs text-neutral-700">{day(r.publishedAt)}</span>
                      <span className="ml-auto flex flex-wrap items-center gap-2">
                        {r.notes && (
                          <button onClick={() => setOpenNotes(openNotes === r.version ? null : r.version)} className="btn-ghost">
                            {openNotes === r.version ? "Hide what changed" : "What changed"}
                          </button>
                        )}
                        <a href={r.htmlUrl} target="_blank" rel="noreferrer" title="Open this version on GitHub" aria-label="Open this version on GitHub" className="btn-icon">
                          <ExternalLink size={16} />
                        </a>
                        {r.exeName ? (
                          <button disabled={busyVersion === r.version} onClick={() => void download(r.version)} className="btn-secondary">
                            <Download size={16} />
                            {busyVersion === r.version ? (pct != null ? `${pct}%` : "Starting") : `Download ${MB(r.sizeBytes)}`}
                          </button>
                        ) : (
                          /* Said on the row, not discovered on click. */
                          <Chip>no installer</Chip>
                        )}
                      </span>
                    </div>
                    {busyVersion === r.version && pct != null && (
                      <div className="mt-2 h-2 overflow-hidden rounded-full bg-neutral-200">
                        <div className="h-full w-full origin-left bg-accent transition-transform" style={{ transform: `scaleX(${Math.max(0, Math.min(100, pct)) / 100})` }} />
                      </div>
                    )}
                    {openNotes === r.version && (
                      /* Plain text, never markup. */
                      <pre className="tile-white mt-2 max-h-56 overflow-auto whitespace-pre-wrap font-sans text-sm text-neutral-700">{r.notes.trim()}</pre>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <p className="mt-2 text-xs text-neutral-700">
            Download saves the installer in your Downloads folder and shows it in Explorer. It never runs it for you.
            Any version can be installed over the current one. This computer's settings are kept outside the program's folder and are not touched.
          </p>
        </Disclosure>
      )}
    </Card>
  );
}

export default UpdatesCard;
