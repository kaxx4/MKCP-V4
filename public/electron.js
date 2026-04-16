const { app, BrowserWindow, Menu, ipcMain, dialog, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const net = require('net');
const { pathToFileURL } = require('url');

// ── GPU crash fix (Windows STATUS_ACCESS_VIOLATION / c000005) ────────────────
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('disable-gpu-sandbox');

// ── Single-instance lock ──────────────────────────────────────────────────────
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// app.isPackaged is reliable; NODE_ENV is NOT set by electron-builder
const isDev = !app.isPackaged;

let mainWindow = null;

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

// ── Start Express server ──────────────────────────────────────────────────────
// Uses dynamic import() — loads the server ESM module directly into the Electron
// main process; no child process, no Windows spawn API.
async function startExpressServer() {
  const serverDist = isDev
    ? path.join(__dirname, '../server/dist/index.js')
    : path.join(process.resourcesPath, 'server/dist/index.js');

  if (!fs.existsSync(serverDist)) {
    throw new Error(`Server entry not found: ${serverDist}`);
  }

  // If port is already occupied, check whether it's our own server responding.
  // This happens when a previous instance left a dangling process.
  const portFree = await isPortFree(3100);
  if (!portFree) {
    console.warn('[server] Port 3100 occupied — checking if existing server is responsive...');
    try {
      await waitForServer(3100, 5000);
      console.log('[server] Existing server on :3100 is up — skipping start');
      return; // already running, nothing to do
    } catch {
      throw new Error(
        'Port 3100 is occupied by another process and not responding.\n' +
        'Please close any other app using port 3100 and restart.'
      );
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
    },
    show: false,
  });

  const startUrl = isDev
    ? 'http://localhost:5173'
    : pathToFileURL(path.join(__dirname, '../dist/index.html')).href;

  mainWindow.loadURL(startUrl).catch((err) => console.error('loadURL failed:', err));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('close', () => { if (mainWindow) setConfig('windowBounds', mainWindow.getBounds()); });
  mainWindow.on('closed', () => { mainWindow = null; });
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
app.whenReady().then(async () => {
  console.log('MK Cycles Dashboard starting...');
  try {
    await startExpressServer();
    console.log('Server ready on :3100');
  } catch (err) {
    console.error('Server failed:', err.message);
    dialog.showErrorBox('API Server Error',
      `The local server could not start.\n\n${err.message}\n\nTally sync will not work.`);
  }
  createWindow();

  // Dev-only keyboard shortcuts (menu bar is hidden in all builds)
  if (isDev) {
    globalShortcut.register('F12', () => mainWindow?.webContents.toggleDevTools());
    globalShortcut.register('F5',  () => mainWindow?.webContents.reload());
  }
  globalShortcut.register('F11', () => {
    if (mainWindow) mainWindow.setFullScreen(!mainWindow.isFullScreen());
  });
});

app.on('window-all-closed', () => {
  globalShortcut.unregisterAll();
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => { if (mainWindow === null) createWindow(); });
