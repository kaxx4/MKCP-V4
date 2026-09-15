const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, dialog, globalShortcut, screen } = require('electron');

let mainWindow = null;
let pipWindow = null;
let tray = null;
let appQuitting = false;
const APP_START = Date.now();

// Default size for the Quick View (picture-in-picture) window. Named so it's
// one place to tune, not a magic number buried in createPipWindow().
const PIP_WINDOW_SIZE = { width: 360, height: 520 };

// ── Crash auto-restart (loop-guarded) ─────────────────────────────────────────
// A bare relaunch-on-any-error is dangerous: an error during shutdown undoes the
// quit (app reopens) and an error during startup turns into an infinite relaunch
// loop where the app never opens cleanly. Guards:
//   • If we're intentionally quitting → just exit, never relaunch.
//   • If the crash happens within the first 30s (boot window) → DON'T relaunch;
//     stay alive so the user can read the error and close the app instead of
//     fighting a flicker loop.
//   • Otherwise → relaunch once.
process.on('uncaughtException', (err) => {
  console.error('[electron] uncaughtException (kept alive):', err);
  if (appQuitting) { app.exit(0); return; }
  // Do NOT auto-relaunch. A throw mid-sync (operational error, transient network,
  // etc.) must not restart the app and interrupt work — that reads to the user as
  // "the app crashed". Log it and stay alive; the window + server keep running.
  // (True process death from OOM can't be caught here anyway; the memory headroom
  // bump below is what prevents that.)
});
process.on('unhandledRejection', (reason) => {
  // Never crash/relaunch on an unhandled promise rejection — just log it.
  console.error('[electron] unhandledRejection:', reason);
});
const { startAutoUpdate, getUpdateState } = require('./autoUpdate');
let updater = null;
const path = require('path');
const fs = require('fs');
const http = require('http');
const net = require('net');
const { exec, execFile } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const { pathToFileURL } = require('url');

// ── GPU crash fix (Windows STATUS_ACCESS_VIOLATION / c000005) ────────────────
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('disable-gpu-sandbox');

// ── RAM efficiency ────────────────────────────────────────────────────────────
// V8 old-space ceiling. The main process hosts the embedded server, which builds
// the full voucher payload in-memory during a sync (a multi-month pull can reach
// hundreds of MB, a full year ~1.5 GB). 2 GB was too tight and a large sync could
// OOM-crash the whole app; 4 GB gives the headroom to finish without crashing.
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=4096');
// Stop Chromium from making background DNS prefetch / update-check requests.
app.commandLine.appendSwitch('disable-background-networking', '');

// ── Single-instance lock ──────────────────────────────────────────────────────
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// app.isPackaged is reliable; NODE_ENV is NOT set by electron-builder
const isDev = !app.isPackaged;

// (mainWindow / tray / appQuitting hoisted to the top for the crash handler)

// ── Config ────────────────────────────────────────────────────────────────────
const configPath = path.join(app.getPath('userData'), 'config.json');
// In-memory cache so getConfig/IPC calls don't re-read + parse the file on every
// call. The main process is the only writer, so the cache stays authoritative;
// writeConfig refreshes it. (External edits are picked up on next launch.)
let _configCache = null;
function readConfig() {
  if (_configCache) return _configCache;
  try { _configCache = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { _configCache = {}; }
  return _configCache;
}
function writeConfig(data) {
  _configCache = data;
  try { fs.writeFileSync(configPath, JSON.stringify(data, null, 2)); } catch {}
}
function getConfig(key, def) { return readConfig()[key] ?? def; }
function setConfig(key, value) { const c = readConfig(); c[key] = value; writeConfig(c); }

// ── Window-bounds safety ────────────────────────────────────────────────────────
// A window that hides-to-tray and is later closed can persist bogus/off-screen
// coordinates (we have seen x/y = -25600). Restoring those opens the window where
// it can't be seen — the app looks "running but broken". These helpers validate
// bounds on both restore and save so an off-screen rect can never stick.
// `configKey` lets the PiP window persist its own bounds under a separate key
// (see below) so the two windows' saved rects never collide.
function getSafeWindowBoundsFor(configKey, defaults) {
  const b = getConfig(configKey, {}) || {};
  const width = b.width || defaults.width;
  const height = b.height || defaults.height;
  if (b.x == null || b.y == null) return { width, height }; // no position → center

  // The window is acceptable only if a meaningful chunk overlaps a real display's
  // work area (enough that the titlebar is on-screen and grabbable).
  const onScreen = screen.getAllDisplays().some((d) => {
    const wa = d.workArea;
    const ox = Math.min(b.x + width, wa.x + wa.width) - Math.max(b.x, wa.x);
    const oy = Math.min(b.y + height, wa.y + wa.height) - Math.max(b.y, wa.y);
    return ox >= 200 && oy >= 100;
  });
  if (!onScreen) {
    console.warn(`[electron] saved bounds for ${configKey} (${b.x},${b.y}) are off-screen — centering instead`);
    return { width, height };
  }
  return { width, height, x: b.x, y: b.y };
}

function getSafeWindowBounds() {
  return getSafeWindowBoundsFor('windowBounds', { width: 1400, height: 900 });
}

function saveWindowBoundsFor(win, configKey) {
  try {
    if (!win) return;
    // Don't persist bounds for a minimized or hidden (in-tray) window — those
    // report meaningless coordinates that would later open the window off-screen.
    if (win.isMinimized() || !win.isVisible()) return;
    const b = win.getNormalBounds(); // restored rect, ignores minimized state
    if (!b || b.width < 200 || b.height < 200) return;
    if (b.x < -10000 || b.y < -10000 || b.x > 50000 || b.y > 50000) return; // absurd → skip
    setConfig(configKey, b);
  } catch {}
}

function saveWindowBounds() {
  saveWindowBoundsFor(mainWindow, 'windowBounds');
}

// ── Wait for server ───────────────────────────────────────────────────────────
function waitForServer(port, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timeoutHandle = setTimeout(() => finish(new Error(`Server on :${port} did not respond within ${timeoutMs / 1000}s`)), timeoutMs);
    function finish(err) {
      if (done) return;
      done = true;
      clearTimeout(timeoutHandle);
      err ? reject(err) : resolve();
    }
    function check() {
      if (done) return;
      const req = http.get(`http://localhost:${port}/`, (res) => { res.resume(); finish(); });
      req.on('error', () => { if (!done) setTimeout(check, 250); });
      req.setTimeout(400, () => req.destroy());
    }
    setTimeout(check, 300);
  });
}

// ── Port availability check ───────────────────────────────────────────────────
function isPortFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
}

// ── Kill stale process on a port (Windows only) ───────────────────────────────
// Async so the (rare) stale-port recovery never blocks the main thread / window.
async function killPortProcess(port) {
  try {
    const { stdout } = await execAsync('netstat -ano', { encoding: 'utf8', timeout: 3000, maxBuffer: 1024 * 1024 });
    const lines = stdout.split('\n').filter(l => l.includes(`:${port} `) && l.includes('LISTENING'));
    for (const line of lines) {
      const pid = line.trim().split(/\s+/).pop();
      if (pid && /^\d+$/.test(pid) && parseInt(pid) > 4) {
        console.warn(`[server] Killing stale PID ${pid} on port ${port}`);
        try { await execFileAsync('taskkill', ['/F', '/PID', pid], { timeout: 3000 }); } catch {}
      }
    }
  } catch {}
}

// ── Start Express server ──────────────────────────────────────────────────────
// Loads the built CJS server bundle straight into the Electron main process with
// require() — no child process, no Windows spawn API. (This said "dynamic
// import()" long after the code stopped doing that; see the require() call below.)
// dotenv can't read server/.env from inside the asar, and the packaged app has
// no OS-level env vars set for it — a literal Supabase service-role key used
// to sit inline here as the fallback, which meant it got committed and pushed
// to the repo. That key must be treated as dead going forward regardless of
// rotation status: a service-role key bypasses RLS entirely, so a leaked one
// is a full-DB read/write credential. Read the SAME values from an actual
// server/.env file instead — bundled into the installer via electron-builder's
// extraResources (see electron-builder.json5), never committed to git
// (server/.env is gitignored). No `dotenv` require here: the Electron main
// process doesn't have that package on its own module path (it's the
// server workspace's dependency, not the root app's), and the format is
// simple enough not to need it.
/** Read KEY=VALUE pairs from a file into process.env, never overriding. */
function applyEnvFile(envPath) {
  if (!envPath || !fs.existsSync(envPath)) return 0;
  let applied = 0;
  for (const rawLine of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const line = rawLine.replace(/\r$/, ''); // tolerate CRLF
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const [, key, rawValue] = m;
    // Same precedence dotenv uses: never override a value already set
    // (e.g. by a real OS-level env var at launch, or an earlier file here).
    if (process.env[key] === undefined) {
      process.env[key] = rawValue.replace(/^["']|["']$/g, '');
      applied++;
    }
  }
  return applied;
}

/**
 * Where this machine's credentials come from, in order.
 *
 * -- Why there is an order at all -----------------------------------------
 *
 * The installer BUNDLES server/.env, which holds a live Supabase SERVICE-ROLE
 * key: 219 characters of JWT that bypasses row-level security on every table in
 * the database. That was a deliberate choice -- it replaced a key hardcoded
 * into this very file, which had already been committed to git -- and it works.
 * It also means the .exe is itself a secret: anyone handed a copy holds full
 * read/write on the company's books.
 *
 * Verified 2026-09-14 by unpacking the installer and reading the key straight
 * out of resources/server/.env.
 *
 * So there is now a place for credentials that is NOT inside the installer: a
 * .env in the app's own userData folder, per machine, never copied when the
 * .exe is. It is read FIRST, and since nothing here overrides a value that is
 * already set, whatever it provides the bundled file can no longer change.
 *
 * That makes a keyless build possible -- drop ".env" from extraResources and
 * put one file on each machine -- without breaking any install that already
 * depends on the bundled one. Until a build does that, the honest description
 * of the .exe is "a secret": do not email it, upload it, or hand it on.
 */
function loadPackagedEnv() {
  /* TWO candidate locations, because one of them is a trap.
     `app.getPath('userData')` is built from package.json's `name`, so the real
     directory is `%APPDATA%/mkcycles-dashboard-electron` — NOT the product name
     the operator sees everywhere else ("MK Cycles Dashboard" in Programs, in
     the Start menu, in the window title). Provisioning a machine by hand means
     guessing, and the obvious guess is wrong: it was got wrong on the very
     first machine, which started with the push agent disabled and a panel
     telling the operator to edit a `server/.env` that no longer ships.

     Both are accepted, the real one first, and the path actually used is
     logged — so the next person can read where it looked instead of guessing
     again. */
  const userDataDir = app.getPath('userData');
  const candidates = [
    path.join(userDataDir, '.env'),
    // The product-named sibling — the folder a human would look for.
    path.join(path.dirname(userDataDir), 'MK Cycles Dashboard', '.env'),
  ].filter((p, i, all) => all.indexOf(p) === i);

  let applied = 0;
  let userEnv = candidates[0];
  for (const candidate of candidates) {
    const n = applyEnvFile(candidate);
    if (n > 0) { applied = n; userEnv = candidate; break; }
  }
  if (applied > 0) {
    console.log(`[server] Loaded ${applied} setting(s) from ${userEnv} (takes precedence over the bundled .env).`);
  }

  const bundled = isDev
    ? path.join(__dirname, '../server/.env')
    : path.join(process.resourcesPath, 'server/.env');

  if (!fs.existsSync(bundled)) {
    if (applied === 0) {
      console.warn(
        '[server] No .env found. Looked in:\n  ' +
        candidates.concat([bundled]).join('\n  ') +
        '\nSupabase-dependent features (sync, remote refresh, push agent) will ' +
        'self-disable until one is provided. Put the file at the FIRST path above.'
      );
    }
    return;
  }

  const hadKeyAlready = process.env.SUPABASE_SERVICE_KEY !== undefined;
  applyEnvFile(bundled);

  /* PROVISIONING: copy the bundled file into userData the first time, so this
     machine keeps its credentials once the bundle stops arriving.

     Only a build made with MKCP_EMBED_ENV=1 carries a bundled .env, and that
     build is never published — it exists to credential a machine by being
     installed, instead of by someone finding %APPDATA% and placing a file in a
     folder named after the package rather than the product. Every ordinary
     release is credential-free, so WITHOUT this copy the next over-the-air
     update would silently take the key away again and the push agent would go
     quiet with nothing on screen saying why.

     Never overwrites: `applied > 0` means this machine already has its own
     file, and a hand-placed one is the operator's, not the installer's. */
  if (applied === 0) {
    const target = candidates[0];
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(bundled, target);
      console.log(
        `[server] Provisioned ${target} from the bundled .env. ` +
        `Updates never touch it, so this machine stays credentialed when the ` +
        `next release ships without one.`,
      );
    } catch (err) {
      console.warn(
        `[server] Could not provision ${target} from the bundled .env: ${err.message}. ` +
        `This launch still works (the bundled copy was applied above), but an ` +
        `over-the-air update to a credential-free release will disable the ` +
        `Supabase features until the file is placed by hand.`,
      );
    }
  }

  /* Said out loud, every launch, when the key in use came out of the installer.
     A secret shipped inside a file people pass around is not something to
     record once in a comment and forget. */
  if (!hadKeyAlready && process.env.SUPABASE_SERVICE_KEY) {
    console.warn(
      `[server] SECURITY: the Supabase service-role key was read from the BUNDLED ${bundled}. ` +
      `This is a PROVISIONING build (MKCP_EMBED_ENV=1) — every copy of its installer ` +
      `carries the key, so treat that .exe as the secret it is: carry it on a USB stick, ` +
      `install it, delete it. Never upload it. Ordinary releases carry no key, which is ` +
      `the only reason they can be published to a public repository at all.`,
    );
  }
}

async function startExpressServer() {
  loadPackagedEnv();

  // Enable the Supabase → Tally push-queue drain agent in the packaged app.
  // Server reads this at module load (index.ts) to call startPushAgent().
  process.env.PUSH_AGENT_ENABLED = process.env.PUSH_AGENT_ENABLED || "true";

  // Fallback company for the remote-refresh listener. The listener actually
  // resolves the company from tally_companies.name (the same source the web's
  // useCompany() reads), so this literal is only used if that lookup returns
  // nothing.
  process.env.TALLY_COMPANY = process.env.TALLY_COMPANY || "M.K.CYCLES (P) LTD. - (from 1-Apr-26)";

  // Local folder the file-transfer sync (server/src/services/fileTransferSync.ts)
  // downloads incoming web-pushed files into. Set via Settings -> "Choose folder"
  // (see the pick-sync-folder IPC handler below); empty until the operator
  // configures one, in which case the server just logs and leaves the transfer
  // pending rather than failing.
  process.env.MKC_SYNC_FOLDER = getConfig('syncFolderPath', '') || '';
  // Outbound half: a folder the operator drops Tally exports into, which the
  // server watches and uploads automatically. Deliberately a DIFFERENT folder
  // from the one above — the agent writes incoming files there, so watching it
  // would send every download straight back where it came from.
  process.env.MKC_WATCH_FOLDER = getConfig('watchFolderPath', '') || '';

  const serverDist = isDev
    ? path.join(__dirname, '../server/dist/index.js')
    : path.join(process.resourcesPath, 'server/dist/index.js');

  if (!fs.existsSync(serverDist)) {
    throw new Error(`Server entry not found: ${serverDist}`);
  }

  // If port is already occupied, check whether it's our own server responding.
  // This happens when a previous instance crashed and left a dangling node process.
  const portFree = await isPortFree(3100);
  if (!portFree) {
    console.warn('[server] Port 3100 occupied — checking if existing server is responsive...');
    try {
      await waitForServer(3100, 3000);
      console.log('[server] Existing server on :3100 is up — skipping start');
      return; // already running, nothing to do
    } catch {
      // Stale process — kill it and continue with normal startup
      console.warn('[server] Port 3100 occupied by non-responsive process — killing it...');
      await killPortProcess(3100);
      // Give OS a moment to release the port
      await new Promise(r => setTimeout(r, 800));
      const nowFree = await isPortFree(3100);
      if (!nowFree) {
        throw new Error(
          'Port 3100 is occupied by another process and could not be released.\n' +
          'Please restart your computer and try again.'
        );
      }
      console.log('[server] Port 3100 freed — starting server...');
    }
  }

  // require() loads the CJS server bundle directly — no dynamic import(), no Windows API issues
  require(serverDist);

  // app.listen() is called by the server module — poll until it's up
  return waitForServer(3100, 20000);
}

// ── Window ────────────────────────────────────────────────────────────────────
function createWindow() {
  const bounds = getSafeWindowBounds();

  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    ...(bounds.x != null && { x: bounds.x }),
    ...(bounds.y != null && { y: bounds.y }),
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      v8CacheOptions: 'code',        // cache compiled JS bytecode → faster re-launches
      // backgroundThrottling left at default (true): Chromium throttles inactive tabs to
      // 1 Hz minimum. The 30-min Tally sync and 5-min backup timers are unaffected at
      // those intervals; rAF-based FPS counting stops (correct — FPS when hidden is useless).
      spellcheck: false,             // not needed in a business app, saves CPU/memory
    },
    show: false,
  });

  const startUrl = isDev
    ? 'http://localhost:5173'
    : pathToFileURL(path.join(__dirname, '../dist/index.html')).href;

  mainWindow.loadURL(startUrl).catch((err) => console.error('loadURL failed:', err));

  // Show on ready-to-show, but force-show after 8s as a fallback so a renderer
  // that white-screens (JS error, blocked on the not-yet-ready :3100 server)
  // can never leave an invisible, unreachable window behind.
  let shown = false;
  const showOnce = () => {
    if (shown || !mainWindow) return;
    shown = true;
    mainWindow.show();
  };
  mainWindow.once('ready-to-show', showOnce);
  setTimeout(showOnce, 8000);
  mainWindow.on('close', (e) => {
    saveWindowBounds(); // only persists valid, on-screen bounds (skips minimized/hidden)
    if (!appQuitting) {
      // Hide to tray instead of closing — keeps sync agent alive.
      e.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── Quick View (picture-in-picture) window ───────────────────────────────────
// Small always-on-top window loading the #/pip route of the same built app.
//
// That route is now real: src/App.tsx reads the hash and renders
// src/QuickView.tsx — approvals waiting, then Tally / push drain / queue, all
// derived by the same functions as the main window's KPI strip
// (src/status/agentFacts.ts) so the two windows cannot disagree.
//
// Until 15-Sep-2026 nothing read the hash, so this window rendered the ENTIRE
// 1,100-line status board at 280-360px — and, less visibly, mounted a second
// `useScheduledSyncs()`, i.e. a duplicate 30-minute Today sync firing at
// TallyPrime's single-threaded XML port from a window nobody was looking at.
// The note that used to sit here called that "a harmless temporary state".
//
// The earlier plan for this window (price verification, discounts, upsell,
// who-to-call tabs) is a web-dashboard feature and was never built anywhere;
// it is not what this window shows.
function createPipWindow() {
  const bounds = getSafeWindowBoundsFor('pipWindowBounds', PIP_WINDOW_SIZE);

  pipWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    ...(bounds.x != null && { x: bounds.x }),
    ...(bounds.y != null && { y: bounds.y }),
    minWidth: 280,
    minHeight: 200,
    alwaysOnTop: true,
    frame: true, // matches mainWindow: no custom titlebar in this app, so keep native chrome
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'), // generic contextBridge API — no PiP-specific IPC needed yet
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      spellcheck: false,
    },
    show: false,
  });

  const startUrl = isDev
    ? 'http://localhost:5173/#/pip'
    : pathToFileURL(path.join(__dirname, '../dist/index.html')).href + '#/pip';

  pipWindow.loadURL(startUrl).catch((err) => console.error('[pip] loadURL failed:', err));
  pipWindow.once('ready-to-show', () => pipWindow?.show());

  // Independently closable: hide instead of destroying so state (position, any
  // in-page state) survives a close/reopen via the shortcut or tray item. This
  // never touches app-quit logic — window-all-closed below only fires once
  // BOTH mainWindow and pipWindow are gone, and even then it explicitly does
  // NOT quit the app (headless sync agent keeps running).
  pipWindow.on('close', (e) => {
    saveWindowBoundsFor(pipWindow, 'pipWindowBounds');
    if (!appQuitting) {
      e.preventDefault();
      pipWindow.hide();
    }
  });
  pipWindow.on('closed', () => { pipWindow = null; });
}

function togglePipWindow() {
  if (!pipWindow || pipWindow.isDestroyed()) {
    createPipWindow();
    return;
  }
  if (pipWindow.isVisible()) {
    pipWindow.hide();
  } else {
    pipWindow.show();
    pipWindow.focus();
  }
}

// ── System tray ───────────────────────────────────────────────────────────────
function createTray() {
  // Use the existing app icon, scaled to 16x16 for the tray.
  const iconPath = path.join(__dirname, 'icon.png');
  let icon;
  try {
    icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
    if (icon.isEmpty()) icon = nativeImage.createEmpty();
  } catch {
    icon = nativeImage.createEmpty();
  }

  tray = new Tray(icon);
  tray.setToolTip('MKCP Sync Agent');

  const buildMenu = () => Menu.buildFromTemplate([
    {
      label: 'Show Status',
      click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } },
    },
    { type: 'separator' },
    {
      label: 'Sync Now',
      // Previously fetch(...).catch(() => {}) — a failure here (Tally closed,
      // network blip, a 409 lock conflict) produced zero feedback for the one
      // action someone actually takes when they suspect data is stale. Surface
      // it the same way the in-window sync buttons do (see AgentStatus.tsx).
      click: async () => {
        const company = readConfig().companyName || 'M.K.CYCLES (P) LTD.';
        try {
          const resp = await fetch('http://localhost:3100/api/tally/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ company, mode: 'smart' }),
          });
          if (!resp.ok) {
            const body = await resp.text().catch(() => '');
            dialog.showErrorBox('Sync failed', `Tally sync returned HTTP ${resp.status}.\n${body.slice(0, 500)}`);
          }
        } catch (err) {
          dialog.showErrorBox('Sync failed', `Couldn't reach the local sync server: ${err.message}`);
        }
      },
    },
    {
      label: 'Drain Queue',
      click: async () => {
        try {
          const resp = await fetch('http://localhost:3100/api/push-agent/drain', { method: 'POST' });
          if (!resp.ok) {
            const body = await resp.text().catch(() => '');
            dialog.showErrorBox('Drain queue failed', `Push agent returned HTTP ${resp.status}.\n${body.slice(0, 500)}`);
          }
        } catch (err) {
          dialog.showErrorBox('Drain queue failed', `Couldn't reach the local sync server: ${err.message}`);
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Toggle Quick View',
      click: () => togglePipWindow(),
    },
    { type: 'separator' },
    {
      label: 'Quit Agent',
      click: () => { appQuitting = true; tray?.destroy(); app.quit(); },
    },
  ]);

  tray.setContextMenu(buildMenu());
  tray.on('double-click', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });
}

// Remove the native menu bar entirely
Menu.setApplicationMenu(null);

// ── IPC ───────────────────────────────────────────────────────────────────────
ipcMain.handle('get-settings', () => readConfig());
ipcMain.handle('set-setting', (_e, key, value) => { setConfig(key, value); return { success: true }; });
ipcMain.handle('get-version', () => app.getVersion());

/* Update state, readable on demand as well as pushed over `update:state`.
   A renderer that mounts after the check has already run would otherwise never
   learn the result — which is the silent-updater failure this is meant to
   avoid. */
ipcMain.handle('update:get-state', () => getUpdateState());
ipcMain.handle('update:check-now', async () => (updater ? updater.checkNow() : getUpdateState()));

// ── Discount Rules file persistence ──────────────────────────────────────────
const discountRulesPath = path.join(app.getPath('userData'), 'discount-rules.json');

ipcMain.handle('discount-rules:load', () => {
  try {
    if (fs.existsSync(discountRulesPath)) {
      return { ok: true, data: JSON.parse(fs.readFileSync(discountRulesPath, 'utf8')) };
    }
    return { ok: false, reason: 'not-found' };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
});

ipcMain.handle('discount-rules:save', (_e, payload) => {
  try {
    fs.writeFileSync(discountRulesPath, JSON.stringify(payload, null, 2));
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
});

ipcMain.handle('discount-rules:export', async (_e, payload) => {
  const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Discount Rules',
    defaultPath: `discount-rules-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (canceled || !filePath) return { ok: false, reason: 'canceled' };
  try {
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
    return { ok: true, filePath };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
});

ipcMain.handle('discount-rules:import', async () => {
  const { filePaths, canceled } = await dialog.showOpenDialog(mainWindow, {
    title: 'Import Discount Rules',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (canceled || filePaths.length === 0) return { ok: false, reason: 'canceled' };
  try {
    const data = JSON.parse(fs.readFileSync(filePaths[0], 'utf8'));
    return { ok: true, data };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
});

// ── File transfer (web ↔ desktop) ──────────────────────────────────────────
// Folder picker for where incoming web-pushed files get saved. Stored via the
// existing get-settings/set-setting config (see readConfig/setConfig above)
// under 'syncFolderPath', and re-read into MKC_SYNC_FOLDER on next app start
// (startExpressServer runs once at boot) -- changing it takes effect after a
// restart, same as every other env-derived setting here.
ipcMain.handle('pick-sync-folder', async () => {
  const { filePaths, canceled } = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a folder for incoming files',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (canceled || filePaths.length === 0) return { ok: false, reason: 'canceled' };
  setConfig('syncFolderPath', filePaths[0]);
  process.env.MKC_SYNC_FOLDER = filePaths[0]; // effective immediately, not just next restart
  return { ok: true, path: filePaths[0] };
});

ipcMain.handle('pick-watch-folder', async () => {
  const { filePaths, canceled } = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a folder to watch for Tally exports',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (canceled || filePaths.length === 0) return { ok: false, reason: 'canceled' };
  const chosen = filePaths[0];
  const downloads = getConfig('syncFolderPath', '');
  if (downloads && path.resolve(downloads) === path.resolve(chosen)) {
    return { ok: false, reason: 'That is already the folder incoming files are saved to. Pick a different one, or files would loop back and forth.' };
  }
  setConfig('watchFolderPath', chosen);
  process.env.MKC_WATCH_FOLDER = chosen;
  // chokidar has already bound to the old path, so the server needs to rebuild
  // the watcher rather than just re-read the env var.
  try {
    await fetch('http://127.0.0.1:3100/api/file-transfer/watch/restart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
  } catch (err) {
    console.warn('[watch-folder] Chosen, but the server did not restart its watcher:', err.message);
  }
  return { ok: true, path: chosen };
});

// File picker for pushing a local file TO the web dashboard — the renderer
// gets a path back and POSTs it to the local server's /api/file-transfer/push,
// which reads it directly (both run in the same machine/process tree).
ipcMain.handle('pick-file-to-push', async () => {
  const { filePaths, canceled } = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a file to send to the web dashboard',
    properties: ['openFile'],
  });
  if (canceled || filePaths.length === 0) return { ok: false, reason: 'canceled' };
  return { ok: true, path: filePaths[0] };
});

app.on('second-instance', () => {
  if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
});

// ── Boot ──────────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  console.log('MK Cycles Dashboard starting...');

  // Open the window and tray FIRST so the UI appears immediately and the user
  // always has a quit affordance — even if the server is slow or fails to start.
  createWindow();
  try {
    createTray();
  } catch (err) {
    console.error('[electron] Tray creation failed (continuing without tray):', err);
  }

  // Start the local server in the BACKGROUND. The renderer polls :3100 and shows
  // a "Disconnected" state until it's up, so a slow (~20s) or failed start no
  // longer blocks the window from appearing.
  startExpressServer()
    .then(() => console.log('Server ready on :3100'))
    .catch((err) => {
      console.error('Server failed:', err.message);
      dialog.showErrorBox('API Server Error',
        `The local server could not start.\n\n${err.message}\n\nTally sync will not work.`);
    });

  /* Over-the-air updates. Safe to publish only because the installer no longer
     carries server/.env — see public/autoUpdate.js and the note on
     `extraResources` in electron-builder.json5. Staged, never forced: this
     process holds Tally's single-threaded port and drains the push queue. */
  try {
    updater = startAutoUpdate({ getWindow: () => mainWindow, isDev });
  } catch (err) {
    console.error('[update] could not start the updater (continuing):', err.message);
  }

  // Quit accelerator — always-available fallback if the tray ever fails.
  const quit = () => { appQuitting = true; tray?.destroy(); app.quit(); };
  globalShortcut.register('CommandOrControl+Q', quit);

  // Dev-only keyboard shortcuts (menu bar is hidden in all builds)
  if (isDev) {
    globalShortcut.register('F12', () => mainWindow?.webContents.toggleDevTools());
    globalShortcut.register('F5',  () => mainWindow?.webContents.reload());
  }
  globalShortcut.register('F11', () => {
    if (mainWindow) mainWindow.setFullScreen(!mainWindow.isFullScreen());
  });

  // Toggle the Quick View (PiP) window. Checked against all shortcuts registered
  // above (Ctrl/Cmd+Q, F12, F5, F11) — no collision.
  globalShortcut.register('CommandOrControl+Shift+P', () => togglePipWindow());
});

app.on('before-quit', () => { appQuitting = true; });
app.on('window-all-closed', () => {
  globalShortcut.unregisterAll();
  // Do NOT quit on window-all-closed. The push agent and pull sync must keep
  // running headlessly. Explicit quit is via the tray "Quit Agent" menu item.
  // On macOS the Dock already keeps the app alive; on Windows/Linux we do the same.
});
app.on('activate', () => {
  // macOS: re-show the window when clicking the Dock icon.
  if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  else createWindow();
});
