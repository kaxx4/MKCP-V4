/*
 * Updates — what has been published, what this machine is running, and getting
 * from one to the other.
 *
 * ── Why this is not just a "check for updates" button ─────────────────────
 *
 * `electron-updater` answers exactly one question: is there something newer
 * than me on the LATEST release? It reads `latest.yml` from the newest release
 * and nothing else. So it cannot show what changed, cannot show history, and
 * cannot go back a version — and the day you want all three is the day an
 * update misbehaved on the office machine and somebody needs the previous one
 * back before trading starts.
 *
 * So there are two paths here, and they are deliberately different:
 *
 *   · **Update now** uses the real OTA path — download in the background,
 *     install on restart. It refuses while a push is in flight unless
 *     overruled, because this process owns Tally's single-threaded XML port and
 *     the push-queue drain, and quitting mid-push abandons a voucher the queue
 *     believes is in flight.
 *
 *   · **Download** on any row fetches that version's installer and shows it in
 *     Explorer. It never runs it. Running an installer is the operator's act,
 *     taken where Windows can tell them what they are about to run — not
 *     something an app does on their behalf from a list.
 *
 * ── Rows that cannot be installed say so on the row ───────────────────────
 *
 * Six of this project's own releases have no `.exe` attached — their assets
 * were deleted on 20-Sep when a published installer turned out to carry 17 real
 * GSTINs. They still appear in the list with their notes, and clicking Download
 * on one would fail. The row says "no installer" instead, because a button that
 * only fails when pressed is worse than no button.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, RefreshCw, CheckCircle2, AlertTriangle, ExternalLink, PackageCheck, Rocket } from "lucide-react";

interface ReleaseRow {
  version: string;
  name: string;
  publishedAt: string | null;
  prerelease: boolean;
  notes: string;
  /** null when the release has no installer attached — see the header. */
  exeName: string | null;
  sizeBytes: number;
  htmlUrl: string;
}

interface UpdateState {
  phase?: "idle" | "checking" | "downloading" | "ready" | "current" | "error" | "disabled" | "installing";
  version?: string;
  percent?: number;
  message?: string;
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
const day = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "";

/** Numeric compare, so 1.5.10 sorts above 1.5.9 — which a string compare does not. */
function cmp(a: string, b: string): number {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

export function UpdatesPanel() {
  const [installed, setInstalled] = useState<string | null>(null);
  const [rows, setRows] = useState<ReleaseRow[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [state, setState] = useState<UpdateState>({});
  const [busyVersion, setBusyVersion] = useState<string | null>(null);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [note, setNote] = useState<string | null>(null);
  const [openNotes, setOpenNotes] = useState<string | null>(null);

  const load = useCallback(async (force = false) => {
    const a = api();
    if (!a?.update?.listReleases) { setLoading(false); setListError("Not running in the desktop app."); return; }
    setLoading(true);
    const res = await a.update.listReleases({ force });
    /* "could not ask" and "nothing published" are different facts and an empty
       list shows them identically — so the reason is kept and rendered. */
    if (!res.ok) { setListError(res.reason ?? "Could not reach GitHub."); setRows([]); }
    else { setListError(null); setRows(res.rows ?? []); }
    setLoading(false);
  }, []);

  useEffect(() => {
    const a = api();
    a?.getVersion?.().then(setInstalled).catch(() => {});
    a?.update?.getState?.().then(setState).catch(() => {});
    void load();
    const offState = a?.update?.onState?.(setState);
    const offProg = a?.update?.onDownloadProgress?.((p) =>
      setProgress((prev) => ({ ...prev, [p.version]: p.percent })));
    return () => { offState?.(); offProg?.(); };
  }, [load]);

  const latest = rows[0];
  const behind = installed && latest ? cmp(latest.version, installed) > 0 : false;

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

  const updateNow = async (force: boolean) => {
    const a = api();
    if (!a?.update) return;
    setNote(null);
    if (state.phase !== "ready") {
      await a.update.checkNow?.();
      setNote("Checking. An update downloads in the background, then this says Ready.");
      return;
    }
    const res = await a.update.installNow?.({ force });
    if (res && !res.ok) {
      setNote(res.reason === "busy"
        /* Named, not a generic failure. The operator is the one who can decide
           whether interrupting is acceptable, and they can only decide that if
           they are told what is happening. */
        ? "A voucher is being sent to Tally right now. Installing now would cut it off halfway. Use \"Install anyway\" only if you accept that."
        : `The install could not be started: ${res.reason}`);
    }
  };

  const statusLine = useMemo(() => {
    switch (state.phase) {
      case "checking": return "Checking for updates.";
      case "downloading": return `Downloading ${state.version ?? "the update"}: ${state.percent ?? 0}% done.`;
      case "ready": return `${state.version} is downloaded and installs when you next close the app.`;
      case "installing": return "Restarting to install.";
      case "current": return "This is the newest published version.";
      case "error": return `The update check failed: ${state.message}`;
      case "disabled": return state.message ?? "This version does not check for updates.";
      default: return null;
    }
  }, [state]);

  return (
    <div className="space-y-4">
      {/* Where this machine stands. One sentence, before any list. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md bg-bg-sub p-2 pl-4 text-sm">
        <PackageCheck size={16} className="shrink-0 text-neutral-500" />
        <span>
          Running <span className="font-medium">{installed ?? "an unknown version"}</span>
        </span>
        {latest && (
          <span className={behind ? "text-warn-700" : "text-neutral-700"}>
            {behind ? `${latest.version} is published.` : "That is the newest published version."}
          </span>
        )}
        <span className="ml-auto flex items-center gap-2">
          <button
            onClick={() => load(true)}
            className="btn-secondary"
          >
            <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
            Check again
          </button>
          {behind && (
            <button
              onClick={() => updateNow(false)}
              className="btn-primary"
            >
              <Rocket size={16} />
              {state.phase === "ready" ? "Install now" : "Update now"}
            </button>
          )}
          {state.phase === "ready" && (
            /* Separate from "Install now" on purpose: this one overrules the
               in-flight-push refusal, and that has to be a distinct decision
               rather than a second click of the same button. */
            <button
              onClick={() => updateNow(true)}
              title="Install even if a voucher is being sent. That voucher may be cut off halfway."
              className="btn-danger text-warn-700"
            >
              Install anyway
            </button>
          )}
        </span>
      </div>

      {statusLine && (
        <p className={`px-1 text-sm ${state.phase === "error" ? "text-danger-700" : "text-neutral-700"}`}>
          {statusLine}
        </p>
      )}
      {note && <p className="note note-info">{note}</p>}

      {listError && (
        <div className="note note-warn">
          <AlertTriangle size={16} className="mt-1 shrink-0" />
          <div>
            <p className="font-medium">The list of published versions could not be read.</p>
            {/* The distinction that matters: an empty list here does not mean
                nothing has been published. */}
            <p className="mt-1">{listError} This means "could not ask", not "nothing has been published".</p>
          </div>
        </div>
      )}

      <ul className={rows.length ? "tray flex flex-col gap-2" : "hidden"}>
        {rows.map((r) => {
          const isInstalled = installed === r.version;
          const pct = progress[r.version];
          return (
            <li key={r.version} className="rounded-md bg-white p-3 shadow-card">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-display text-lg">{r.version}</span>
                {isInstalled && (
                  <span className="pill pill-good">
                    installed
                  </span>
                )}
                {r === latest && !isInstalled && (
                  <span className="pill pill-live">newest</span>
                )}
                {r.prerelease && (
                  <span className="pill pill-warn">test version</span>
                )}
                <span className="text-xs text-neutral-700">{day(r.publishedAt)}</span>

                <span className="ml-auto flex items-center gap-2">
                  {r.notes && (
                    <button
                      onClick={() => setOpenNotes(openNotes === r.version ? null : r.version)}
                      className="btn-ghost"
                    >
                      {openNotes === r.version ? "Hide what changed" : "What changed"}
                    </button>
                  )}
                  <a
                    href={r.htmlUrl} target="_blank" rel="noreferrer"
                    title="Open this version on GitHub"
                    aria-label="Open this version on GitHub"
                    className="btn-icon"
                  >
                    <ExternalLink size={16} />
                  </a>
                  {r.exeName ? (
                    <button
                      disabled={busyVersion === r.version}
                      onClick={() => download(r.version)}
                      className="btn-secondary"
                    >
                      <Download size={16} />
                      {busyVersion === r.version ? (pct != null ? `${pct}%` : "starting") : `Download ${MB(r.sizeBytes)}`}
                    </button>
                  ) : (
                    /* Said on the row, not discovered on click. */
                    <span
                      title="This version's installer was removed. Its notes are still here, but there is nothing to install."
                      className="pill"
                    >
                      no installer
                    </span>
                  )}
                </span>
              </div>

              {busyVersion === r.version && pct != null && (
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-bg-sub">
                  <div className="h-full w-full origin-left bg-accent transition-transform" style={{ transform: `scaleX(${Math.max(0, Math.min(100, pct)) / 100})` }} />
                </div>
              )}

              {openNotes === r.version && (
                /* Plain text, never markup. The body comes from a GitHub release
                   and rendering it as HTML would put remote content into the
                   app's DOM for no benefit. */
                <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded-sm bg-bg-sub p-3 font-sans text-sm text-neutral-700">
                  {r.notes.trim()}
                </pre>
              )}
            </li>
          );
        })}
      </ul>

      {!loading && !rows.length && !listError && (
        <p className="px-1 text-sm text-neutral-700">No versions have been published yet.</p>
      )}

      <p className="px-1 text-xs text-neutral-700">
        Download saves the installer in your Downloads folder and shows it in Explorer. It never runs it for you.
        Any version can be installed over the current one. This computer's settings are kept outside the program's folder and are not touched.
      </p>
    </div>
  );
}
