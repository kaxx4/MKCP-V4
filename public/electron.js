const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, dialog, globalShortcut } = require('electron');

let mainWindow = null;
let tray = null;
let appQuitting = false;
const APP_START = Date.now();

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
  console.error('[electron] uncaughtException:', err);
  if (appQuitting) { app.exit(0); return; }
  if (Date.now() - APP_START < 30_000) {
    console.error('[electron] crash during startup — NOT relaunching (avoids boot loop)');
    return;
  }
  console.error('[electron] relaunching after crash');
  app.relaunch();
  app.exit(0);
});
process.on('unhandledRejection', (reason) => {
  // Never crash/relaunch on an unhandled promise rejection — just log it.
  console.error('[electron] unhandledRejection:', reason);
});
const path = require('path');
const fs = require('fs');
const http = require('http');
const net = require('net');
const { execSync, execFileSync } = require('child_process');
const { pathToFileURL } = require('url');

// ── GPU crash fix (Windows STATUS_ACCESS_VIOLATION / c000005) ────────────────
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('disable-gpu-sandbox');

// ── RAM efficiency ────────────────────────────────────────────────────────────
// Cap renderer V8 old-space at 2 GB (default is 4 GB on 64-bit).
// Parsed Tally data is ~100–500 MB of JS objects; 2 GB gives 4–20× headroom
// while triggering GC earlier and keeping memory pressure lower.
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=2048');
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
function readConfig() {
  try { return JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { return {}; }
}
function writeConfig(data) {
  try { fs.writeFileSync(configPath, JSON.stringify(data, null, 2)); } catch {}
}
function getConfig(key, def) { return readConfig()[key] ?? def; }
function setConfig(key, value) { const c = readConfig(); c[key] = value; writeConfig(c); }

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
function killPortProcess(port) {
  try {
    const out = execSync(`netstat -ano`, { encoding: 'utf8', timeout: 3000, maxBuffer: 1024 * 1024 });
    const lines = out.split('\n').filter(l => l.includes(`:${port} `) && l.includes('LISTENING'));
    for (const line of lines) {
      const pid = line.trim().split(/\s+/).pop();
      if (pid && /^\d+$/.test(pid) && parseInt(pid) > 4) {
        console.warn(`[server] Killing stale PID ${pid} on port ${port}`);
        try { execFileSync('taskkill', ['/F', '/PID', pid], { timeout: 3000 }); } catch {}
      }
    }
  } catch {}
}

// ── Start Express server ──────────────────────────────────────────────────────
// Uses dynamic import() — loads the server ESM module directly into the Electron
// main process; no child process, no Windows spawn API.
async function startExpressServer() {
  // Set Supabase env vars before the server loads (critical for production builds
  // where dotenv won't find the .env file in the app package)
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://vmkytsytxlofjyeotmgb.supabase.co";
  process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZta3l0c3l0eGxvZmp5ZW90bWdiIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3ODY0MjAyMCwiZXhwIjoyMDk0MjE4MDIwfQ.W-LfPU_GMCFafIWjHt0n5bs1oC08IX7IuXLj6TVY1BU";

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
      killPortProcess(3100);
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
  const bounds = getConfig('windowBounds', {});

  mainWindow = new BrowserWindow({
    width: bounds.width || 1400,
    height: bounds.height || 900,
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
    try { if (mainWindow) setConfig('windowBounds', mainWindow.getBounds()); } catch {}
    if (!appQuitting) {
      // Hide to tray instead of closing — keeps sync agent alive.
      e.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
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
      click: () => {
        const company = readConfig().companyName || 'M.K.CYCLES (P) LTD.';
        fetch('http://localhost:3100/api/tally/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ company, mode: 'smart' }),
        }).catch(() => {});
      },
    },
    {
      label: 'Drain Queue',
      click: () => fetch('http://localhost:3100/api/push-agent/drain', { method: 'POST' }).catch(() => {}),
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
