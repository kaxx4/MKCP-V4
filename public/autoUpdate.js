/**
 * Over-the-air updates for the sync agent.
 *
 * ── Why this needed a change to what ships, not just a library ────────────
 *
 * Until now the installer bundled `server/.env` — the live Supabase
 * service-role key, which bypasses RLS on every table. `kaxx4/MKCP-V4` is a
 * PUBLIC repository, so publishing that artifact to its Releases would have put
 * the key on the open internet. OTA was therefore blocked on getting the secret
 * out of the installer, not on the updater itself.
 *
 * `loadPackagedEnv()` already preferred `<userData>/.env` over the bundled copy,
 * so the fix was to stop bundling: the installer is now credential-free and
 * safe to publish, and each machine keeps its own `.env` in userData, which
 * updates never touch. A machine with no userData/.env gets the loader's
 * existing warning and self-disables its Supabase features rather than running
 * on a key that arrived by download.
 *
 * ── How it behaves ────────────────────────────────────────────────────────
 *
 * Checks on launch and every six hours. Downloads in the background. It does
 * NOT restart by itself: this process holds Tally's single-threaded XML port
 * and drains the push queue, so quitting mid-push would abandon a voucher the
 * queue believes is in flight. The update is staged and applied on the next
 * ordinary quit, with the renderer told so it can say "an update is ready".
 *
 * Every state is reported to the renderer over `update:state` and logged. An
 * updater that fails silently is worse than none: the operator believes they
 * are current when they are months behind, which is exactly the situation that
 * made the manual reinstall necessary in the first place.
 */
/* Required LAZILY, inside startAutoUpdate. `electron-updater` builds its
   NsisUpdater the moment the module is read, and that constructor reaches for
   Electron's `app.getVersion()` — so a top-level require throws outside
   Electron (any smoke test, any lint that loads the file) and does real work in
   a dev build that never uses it. */

/** Six hours. Long enough not to matter, short enough that a day-old fix lands. */
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

let broadcast = () => {};
/** Last known state, so a renderer that mounts late can still be told. */
let lastState = { phase: 'idle' };

function setState(next) {
  lastState = { ...next, at: new Date().toISOString() };
  console.log(`[update] ${lastState.phase}${lastState.version ? ' ' + lastState.version : ''}${lastState.message ? ' — ' + lastState.message : ''}`);
  try { broadcast(lastState); } catch { /* window gone */ }
}

function getUpdateState() {
  return lastState;
}

/**
 * @param {object} opts
 * @param {() => Electron.BrowserWindow | null} opts.getWindow
 * @param {boolean} opts.isDev
 * @param {() => boolean} [opts.isBusy] True while a push is in flight, so
 *   "install now" can refuse rather than kill a voucher mid-push.
 */
function startAutoUpdate({ getWindow, isDev, isBusy }) {
  broadcast = (state) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('update:state', state);
  };

  if (isDev) {
    setState({ phase: 'disabled', message: 'Development build — updates are not checked.' });
    /* The release LIST and the per-version download work in dev too: they are
       plain HTTPS against a public repo, and a panel that goes blank in dev is a
       panel nobody can develop. Only the electron-updater half is disabled. */
    return { checkNow: async () => lastState, installNow: async () => ({ ok: false, reason: 'Development build.' }), getUpdateState, listReleases, downloadRelease };
  }

  const { autoUpdater } = require('electron-updater');

  /* Staged, never forced. See the header: this process owns Tally's port and
     the push-queue drain, and electron-updater's default quit-and-install
     behaviour would end both mid-flight. */
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = { info: console.log, warn: console.warn, error: console.error, debug: () => {} };

  autoUpdater.on('checking-for-update', () => setState({ phase: 'checking' }));
  autoUpdater.on('update-available', (info) =>
    setState({
      phase: 'downloading',
      version: info?.version,
      /* Carried through so the operator can see WHAT is being installed before
         they choose to restart into it. A version number alone asks someone to
         accept an interruption on trust. `releaseNotes` is HTML or a string
         depending on how the release was published; the renderer treats it as
         text either way rather than injecting markup. */
      notes: typeof info?.releaseNotes === 'string' ? info.releaseNotes : null,
      releaseName: info?.releaseName ?? null,
      releaseDate: info?.releaseDate ?? null,
    }));
  autoUpdater.on('update-not-available', (info) =>
    setState({ phase: 'current', version: info?.version }));
  autoUpdater.on('download-progress', (p) =>
    setState({ phase: 'downloading', percent: Math.round(p?.percent ?? 0) }));
  autoUpdater.on('update-downloaded', (info) =>
    setState({
      phase: 'ready',
      version: info?.version,
      notes: typeof info?.releaseNotes === 'string' ? info.releaseNotes : null,
      releaseName: info?.releaseName ?? null,
      releaseDate: info?.releaseDate ?? null,
      message: 'Ready. Installs when you next close the app — or install it now.',
    }));
  /* Named, not swallowed. The commonest causes are no network and a release
     published without its latest.yml, and both look identical from the UI
     unless the reason is carried through. */
  autoUpdater.on('error', (err) =>
    setState({ phase: 'error', message: String(err?.message || err) }));

  const check = () => {
    autoUpdater.checkForUpdates().catch((err) =>
      setState({ phase: 'error', message: String(err?.message || err) }));
  };

  /* Not on the first tick of the event loop: the window and the local server
     are still coming up, and a failed check that lands before the renderer
     mounts is a state nobody sees. */
  setTimeout(check, 30_000);
  setInterval(check, CHECK_EVERY_MS);

  /**
   * Install the downloaded update NOW, restarting the app.
   *
   * ── Why this is a deliberate act and not a button that just works ────────
   *
   * This process owns two things nothing else can take over while it runs:
   * Tally's single-threaded XML port, and the push-queue drain. Quitting
   * mid-flight ends a voucher push between "Tally created it" and "the queue
   * row says so" — the exact window `reconcile()` exists to clean up after.
   *
   * So the caller must say whether it is safe, and that judgement is made where
   * the truth is: the agent knows if a job is in flight. `force` is the
   * operator overruling it, which is theirs to do, but never the default.
   *
   * `isSilent=false` so the NSIS installer shows itself — a machine that
   * appears to close and do nothing is how an operator ends up double-clicking
   * the icon during an install. `isForceRunAfter=true` brings the agent back up
   * on its own, because a sync agent nobody restarts is a sync that stopped.
   */
  const installNow = async ({ force = false } = {}) => {
    if (lastState.phase !== 'ready') {
      return { ok: false, reason: 'No downloaded update is waiting.' };
    }
    if (!force && typeof isBusy === 'function' && isBusy()) {
      return { ok: false, reason: 'busy' };
    }
    setState({ ...lastState, phase: 'installing', message: 'Restarting to install…' });
    /* Let the reply reach the renderer before the window goes. */
    setTimeout(() => autoUpdater.quitAndInstall(false, true), 400);
    return { ok: true };
  };

  return {
    checkNow: async () => { check(); return lastState; },
    installNow,
    getUpdateState,
    listReleases,
    downloadRelease,
  };
}

/* ── The release list, and installing a version of your choosing ──────────────
 *
 * `electron-updater` answers exactly one question: "is there something newer
 * than me on the LATEST release?" It reads `latest.yml` from the newest release
 * and nothing else — so it cannot list history, cannot describe what changed
 * three versions ago, and cannot go backwards. Every one of those is a thing an
 * operator needs precisely on the day an update misbehaves.
 *
 * So this half talks to the GitHub Releases API directly and downloads the
 * chosen installer to disk for the operator to run. It deliberately does NOT
 * try to make electron-updater install an arbitrary version: that would mean
 * rewriting the feed underneath it, and a half-supported downgrade path is
 * worse than an honest manual one.
 *
 * ── The one hard limit, stated rather than discovered ─────────────────────
 *
 * OWNER/REPO mirror electron-builder.json5's `publish` block, and the
 * downloader accepts a VERSION, never a URL. A renderer cannot ask this to
 * fetch an executable from somewhere else — which matters, because the thing
 * at the end of it is an installer.
 */
const RELEASES_OWNER = 'kaxx4';
const RELEASES_REPO = 'MKCP-V4';
const RELEASES_API = `https://api.github.com/repos/${RELEASES_OWNER}/${RELEASES_REPO}/releases`;

/** A version string, and nothing that could be a path, a host or a flag. */
const SAFE_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.]+)?$/;

let releaseCache = { at: 0, rows: [] };

/**
 * Every published release, newest first.
 *
 * Unauthenticated — the repo is public and the limit is 60 requests an hour,
 * which one operator clicking refresh cannot reach. Cached for a minute so a
 * re-render does not spend one.
 *
 * A failure returns `{ ok:false, reason }` rather than an empty list, because
 * "no releases" and "could not ask" look identical in a list and only one of
 * them is worth acting on.
 */
async function listReleases({ force = false } = {}) {
  if (!force && Date.now() - releaseCache.at < 60_000 && releaseCache.rows.length) {
    return { ok: true, rows: releaseCache.rows, cached: true };
  }
  try {
    const res = await fetch(`${RELEASES_API}?per_page=30`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'mkcycles-sync-agent' },
    });
    if (!res.ok) return { ok: false, reason: `GitHub answered ${res.status}` };
    const raw = await res.json();
    const rows = (Array.isArray(raw) ? raw : [])
      .filter((r) => !r.draft)
      .map((r) => {
        const exe = (r.assets || []).find((a) => /\.exe$/i.test(a.name || ''));
        return {
          version: String(r.tag_name || '').replace(/^v/, ''),
          name: r.name || r.tag_name,
          publishedAt: r.published_at,
          prerelease: !!r.prerelease,
          notes: typeof r.body === 'string' ? r.body : '',
          /* An asset-less release is the failure mode that looks like success:
             it appears in the list, it has notes, and there is nothing to
             install. Say so on the row rather than failing at download time —
             six of this project's own releases had their .exe deleted. */
          exeName: exe ? exe.name : null,
          sizeBytes: exe ? exe.size : 0,
          htmlUrl: r.html_url,
        };
      });
    releaseCache = { at: Date.now(), rows };
    return { ok: true, rows };
  } catch (err) {
    return { ok: false, reason: String(err?.message || err) };
  }
}

/**
 * Download one release's installer to the Downloads folder.
 *
 * It downloads and REVEALS; it never executes. Running an installer is the
 * operator's act, taken in Explorer where Windows can show them what they are
 * about to run — not something this app does on their behalf from a list.
 */
async function downloadRelease(version, { onProgress } = {}) {
  const { app, shell } = require('electron');
  const { createWriteStream, existsSync, statSync, mkdirSync, renameSync } = require('fs');
  const { join } = require('path');
  const { Readable } = require('stream');
  const { pipeline } = require('stream/promises');

  if (!SAFE_VERSION.test(String(version || ''))) {
    return { ok: false, reason: 'Not a version number.' };
  }
  const listed = await listReleases();
  if (!listed.ok) return { ok: false, reason: listed.reason };
  const row = listed.rows.find((r) => r.version === version);
  if (!row) return { ok: false, reason: `No published release ${version}.` };
  if (!row.exeName) return { ok: false, reason: `Release ${version} has no installer attached.` };

  const dir = app.getPath('downloads');
  try { mkdirSync(dir, { recursive: true }); } catch { /* already there */ }
  const dest = join(dir, row.exeName);

  /* Already downloaded, and the right size? Reveal it rather than spending
     85 MB again. Size is checked, not just existence, because a half-finished
     download from a dropped connection is the copy most likely to be sitting
     there looking complete. */
  if (existsSync(dest) && row.sizeBytes && statSync(dest).size === row.sizeBytes) {
    shell.showItemInFolder(dest);
    return { ok: true, path: dest, alreadyHad: true };
  }

  /* Built from the VERSION, through this repo's own release path — never a URL
     the caller supplied. */
  const url = `https://github.com/${RELEASES_OWNER}/${RELEASES_REPO}/releases/download/v${version}/${encodeURIComponent(row.exeName)}`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'mkcycles-sync-agent' }, redirect: 'follow' });
    if (!res.ok || !res.body) return { ok: false, reason: `Download failed — GitHub answered ${res.status}` };
    const total = Number(res.headers.get('content-length')) || row.sizeBytes || 0;
    let seen = 0;
    const body = Readable.fromWeb(res.body);
    body.on('data', (chunk) => {
      seen += chunk.length;
      if (onProgress && total) onProgress({ version, percent: Math.round((seen / total) * 100), seen, total });
    });
    /* Write to `.part` and rename only once complete, so a dropped connection
       never leaves a file in Downloads that LOOKS like a working installer. */
    const part = `${dest}.part`;
    await pipeline(body, createWriteStream(part));
    renameSync(part, dest);
    shell.showItemInFolder(dest);
    return { ok: true, path: dest, bytes: seen };
  } catch (err) {
    return { ok: false, reason: String(err?.message || err) };
  }
}

module.exports = { startAutoUpdate, getUpdateState, listReleases, downloadRelease };
