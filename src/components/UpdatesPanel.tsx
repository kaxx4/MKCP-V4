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
      ? `${v} ${res.alreadyHad ? "was already in" : "saved to"} Downloads — shown in Explorer. Run it to install.`
      : `Could not download ${v}: ${res.reason}`);
  };

  const updateNow = async (force: boolean) => {
    const a = api();
    if (!a?.update) return;
    setNote(null);
    if (state.phase !== "ready") {
      await a.update.checkNow?.();
      setNote("Checking — an update downloads in the background, then this says Ready.");
      return;
    }
    const res = await a.update.installNow?.({ force });
    if (res && !res.ok) {
      setNote(res.reason === "busy"
        /* Named, not a generic failure. The operator is the one who can decide
           whether interrupting is acceptable, and they can only decide that if
           they are told what is happening. */
        ? "A push is in flight. Installing now would abandon a voucher mid-push — use Force install if you accept that."
        : `Could not install: ${res.reason}`);
    }
  };

  const statusLine = useMemo(() => {
    switch (state.phase) {
      case "checking": return "Checking for updates…";
      case "downloading": return `Downloading ${state.version ?? ""}… ${state.percent ?? 0}%`;
      case "ready": return `${state.version} is downloaded and installs when you next close the app.`;
      case "installing": return "Restarting to install…";
      case "current": return "This is the newest published version.";
      case "error": return `Update check failed — ${state.message}`;
      case "disabled": return state.message ?? "Updates are not checked in this build.";
      default: return null;
    }
  }, [state]);

  return (
    <div className="space-y-3">
      {/* Where this machine stands. One sentence, before any list. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-neutral-50 px-3 py-2.5 text-[12px]">
        <PackageCheck size={14} className="shrink-0 text-neutral-500" />
        <span>
          Running <span className="font-mono font-semibold">{installed ?? "…"}</span>
        </span>
        {latest && (
          <span className={behind ? "text-warn-800" : "text-neutral-500"}>
            {behind ? `· ${latest.version} is published` : "· newest published"}
          </span>
        )}
        <span className="ml-auto flex items-center gap-2">
          <button
            onClick={() => load(true)}
            className="inline-flex items-center gap-1 rounded-lg border border-neutral-200 px-2 py-1 hover:bg-white"
          >
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
            Refresh
          </button>
          {behind && (
            <button
              onClick={() => updateNow(false)}
              className="inline-flex items-center gap-1 rounded-lg bg-accent px-2 py-1 font-semibold text-white hover:opacity-90"
            >
              <Rocket size={12} />
              {state.phase === "ready" ? "Install now" : "Update now"}
            </button>
          )}
          {state.phase === "ready" && (
            /* Separate from "Install now" on purpose: this one overrules the
               in-flight-push refusal, and that has to be a distinct decision
               rather than a second click of the same button. */
            <button
              onClick={() => updateNow(true)}
              title="Install even if a push is in flight. A voucher mid-push may be abandoned."
              className="inline-flex items-center gap-1 rounded-lg border border-warn/40 bg-warn-soft px-2 py-1 font-semibold text-warn-800 hover:bg-warn/15"
            >
              Force install
            </button>
          )}
        </span>
      </div>

      {statusLine && (
        <p className={`px-1 text-[12px] ${state.phase === "error" ? "text-danger-700" : "text-neutral-600"}`}>
          {statusLine}
        </p>
      )}
      {note && <p className="rounded-xl bg-accent-soft px-3 py-2 text-[12px] text-accent-700">{note}</p>}

      {listError && (
        <div className="flex items-start gap-2 rounded-xl bg-warn-soft px-3 py-2.5 text-[12px] text-warn-800">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <div>
            <p className="font-semibold">Could not read the published releases.</p>
            {/* The distinction that matters: an empty list here does not mean
                nothing has been published. */}
            <p className="mt-1">{listError} — this is "could not ask", not "nothing published".</p>
          </div>
        </div>
      )}

      <ul className="flex flex-col gap-2">
        {rows.map((r) => {
          const isInstalled = installed === r.version;
          const pct = progress[r.version];
          return (
            <li key={r.version} className="rounded-xl border border-neutral-200 px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-mono text-[13px] font-semibold">{r.version}</span>
                {isInstalled && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-[10px] font-semibold text-success">
                    <CheckCircle2 size={10} /> installed
                  </span>
                )}
                {r === latest && !isInstalled && (
                  <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-semibold text-accent-700">latest</span>
                )}
                {r.prerelease && (
                  <span className="rounded-full bg-warn/15 px-2 py-0.5 text-[10px] font-semibold text-warn-800">pre-release</span>
                )}
                <span className="text-[11px] text-neutral-500">{day(r.publishedAt)}</span>

                <span className="ml-auto flex items-center gap-2">
                  {r.notes && (
                    <button
                      onClick={() => setOpenNotes(openNotes === r.version ? null : r.version)}
                      className="text-[11px] text-neutral-600 underline underline-offset-2 hover:text-neutral-900"
                    >
                      {openNotes === r.version ? "hide notes" : "what changed"}
                    </button>
                  )}
                  <a
                    href={r.htmlUrl} target="_blank" rel="noreferrer"
                    title="Open this release on GitHub"
                    className="inline-flex items-center gap-1 text-[11px] text-neutral-500 hover:text-neutral-800"
                  >
                    <ExternalLink size={11} />
                  </a>
                  {r.exeName ? (
                    <button
                      disabled={busyVersion === r.version}
                      onClick={() => download(r.version)}
                      className="inline-flex items-center gap-1 rounded-lg border border-neutral-200 px-2 py-1 text-[11px] hover:bg-neutral-50 disabled:opacity-60"
                    >
                      <Download size={11} />
                      {busyVersion === r.version ? (pct != null ? `${pct}%` : "starting…") : `Download ${MB(r.sizeBytes)}`}
                    </button>
                  ) : (
                    /* Said on the row, not discovered on click. */
                    <span
                      title="This release's installer was removed. Its notes are still here, but there is nothing to install."
                      className="rounded-lg bg-neutral-100 px-2 py-1 text-[11px] text-neutral-500"
                    >
                      no installer
                    </span>
                  )}
                </span>
              </div>

              {busyVersion === r.version && pct != null && (
                <div className="mt-2 h-1 overflow-hidden rounded-full bg-neutral-100">
                  <div className="h-full bg-accent transition-[width] duration-200" style={{ width: `${pct}%` }} />
                </div>
              )}

              {openNotes === r.version && (
                /* Plain text, never markup. The body comes from a GitHub release
                   and rendering it as HTML would put remote content into the
                   app's DOM for no benefit. */
                <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded-lg bg-neutral-50 px-3 py-2 font-sans text-[11.5px] leading-relaxed text-neutral-700">
                  {r.notes.trim()}
                </pre>
              )}
            </li>
          );
        })}
      </ul>

      {!loading && !rows.length && !listError && (
        <p className="px-1 text-[12px] text-neutral-500">No releases have been published yet.</p>
      )}

      <p className="px-1 text-[11px] leading-relaxed text-neutral-500">
        Download saves the installer to your Downloads folder and shows it in Explorer — it never runs it.
        Any version can be installed over the current one; the app's settings and its{" "}
        <span className="font-mono">.env</span> live outside the install folder and are not touched.
      </p>
    </div>
  );
}
