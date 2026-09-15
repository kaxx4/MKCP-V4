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
 */
function startAutoUpdate({ getWindow, isDev }) {
  broadcast = (state) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('update:state', state);
  };

  if (isDev) {
    setState({ phase: 'disabled', message: 'Development build — updates are not checked.' });
    return { checkNow: async () => lastState, getUpdateState };
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
    setState({ phase: 'downloading', version: info?.version }));
  autoUpdater.on('update-not-available', (info) =>
    setState({ phase: 'current', version: info?.version }));
  autoUpdater.on('download-progress', (p) =>
    setState({ phase: 'downloading', percent: Math.round(p?.percent ?? 0) }));
  autoUpdater.on('update-downloaded', (info) =>
    setState({
      phase: 'ready',
      version: info?.version,
      message: 'Installs when you next close the app.',
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

  return {
    checkNow: async () => { check(); return lastState; },
    getUpdateState,
  };
}

module.exports = { startAutoUpdate, getUpdateState };
