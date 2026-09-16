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
    return { checkNow: async () => lastState, installNow: async () => ({ ok: false, reason: 'Development build.' }), getUpdateState };
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
  };
}

module.exports = { startAutoUpdate, getUpdateState };
