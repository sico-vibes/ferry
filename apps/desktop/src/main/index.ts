import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  MessageChannelMain,
  shell,
  utilityProcess,
  type UtilityProcess,
} from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  WINDOW_BACKGROUND,
  WINDOW_LIGHT_BACKGROUND,
  WINDOW_LIGHT_SYMBOL,
  WINDOW_SYMBOL,
} from './window-theme.js';

// Packaged builds use the icon embedded in the .exe by electron-builder (build/icon.ico).
const DEV_WINDOW_ICON = join(import.meta.dirname, '../../build/icon.ico');

const e2eUserDataPath = process.env.FERRY_E2E_USER_DATA_DIR;
if (e2eUserDataPath) app.setPath('userData', e2eUserDataPath);

interface SavedBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

let mainWindow: BrowserWindow | null = null;
let saveTimer: NodeJS.Timeout | undefined;
let coreProcess: UtilityProcess | null = null;
let corePid: number | null = null;
let coreReady = false;
let restartCount = 0;
let coreRestartTimer: NodeJS.Timeout | undefined;
let shuttingDown = false;
const coreConnectors: Electron.WebContents[] = [];

function boundsPath(): string {
  return join(app.getPath('userData'), 'window-bounds.json');
}

function readBounds(): SavedBounds {
  const fallback: SavedBounds = { width: 1440, height: 900 };
  try {
    const path = boundsPath();
    if (!existsSync(path)) return fallback;
    const candidate = JSON.parse(readFileSync(path, 'utf8')) as SavedBounds;
    if (candidate.width < 1024 || candidate.height < 680) return fallback;
    return candidate;
  } catch {
    return fallback;
  }
}

function saveBounds(window: BrowserWindow): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const value = window.isMaximized() ? window.getNormalBounds() : window.getBounds();
    writeFileSync(boundsPath(), JSON.stringify(value), 'utf8');
  }, 250);
}

function isExternalHttp(url: string): boolean {
  return url.startsWith('https://') || url.startsWith('http://');
}

function broadcastEngineRestarting(): void {
  for (const window of BrowserWindow.getAllWindows())
    window.webContents.send('ferry:engine-restarting');
}

function broadcastEngineConnected(): void {
  for (const window of BrowserWindow.getAllWindows())
    window.webContents.send('ferry:engine-connected');
}

function transferCorePort(sender: Electron.WebContents): void {
  if (sender.isDestroyed()) return;
  if (!coreProcess) {
    coreConnectors.push(sender);
    return;
  }
  const channel = new MessageChannelMain();
  coreProcess.postMessage({ type: 'ferry:attach' }, [channel.port1]);
  sender.postMessage('ferry:core-port', undefined, [channel.port2]);
}

function launchCore(): void {
  if (shuttingDown) return;
  const coreEntry = join(import.meta.dirname, 'core-entry.js');
  const child = utilityProcess.fork(coreEntry, [], {
    serviceName: 'Ferry Core',
    env: {
      ...process.env,
      FERRY_REAL_DOMAINS:
        process.env.FERRY_REAL_DOMAINS ?? 'settings,workspaces,checkpoints,providers,models,quota',
      FERRY_CORE_DATA_DIR: process.env.FERRY_HOME ?? join(app.getPath('userData'), 'engine'),
    },
    stdio: process.env.FERRY_E2E_USER_DATA_DIR ? 'pipe' : 'inherit',
  });
  if (process.env.FERRY_E2E_USER_DATA_DIR)
    child.stderr?.on('data', (chunk: unknown) => {
      console.error('FERRY_CORE_STDERR ' + String(chunk));
    });
  coreProcess = child;
  corePid = child.pid ?? null;
  coreReady = false;
  child.on('message', (message: unknown) => {
    if (
      coreProcess !== child ||
      typeof message !== 'object' ||
      message === null ||
      !('type' in message) ||
      message.type !== 'ferry:core-ready'
    )
      return;
    coreReady = true;
    restartCount = 0;
    broadcastEngineConnected();
    if (process.env.FERRY_E2E_USER_DATA_DIR && 'selfTest' in message)
      console.log(`FERRY_CORE_READY ${JSON.stringify(message)}`);
  });
  child.on('exit', (code) => {
    if (process.env.FERRY_E2E_USER_DATA_DIR) console.error(`FERRY_CORE_EXIT ${String(code)}`);
    if (coreProcess !== child || shuttingDown) return;
    coreProcess = null;
    corePid = null;
    coreReady = false;
    restartCount += 1;
    broadcastEngineRestarting();
    const delay = Math.min(500 * 2 ** Math.min(restartCount - 1, 5), 15_000);
    coreRestartTimer = setTimeout(launchCore, delay);
  });
  child.on('spawn', () => {
    if (process.env.FERRY_E2E_USER_DATA_DIR) console.log('FERRY_UTILITY_SPAWN');
    if (process.env.FERRY_E2E_CORE_ONLY) {
      const channel = new MessageChannelMain();
      child.postMessage({ type: 'ferry:attach' }, [channel.port1]);
      channel.port2.on('message', (event) => {
        if (process.env.FERRY_E2E_USER_DATA_DIR)
          console.error('FERRY_CORE_MESSAGE ' + JSON.stringify(event.data));
      });
      channel.port2.start();
    }
    for (const sender of coreConnectors.splice(0)) transferCorePort(sender);
  });
}

async function createWindow(): Promise<void> {
  const bounds = readBounds();
  const preload = join(import.meta.dirname, '../preload/index.cjs');
  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 1024,
    minHeight: 680,
    frame: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: WINDOW_BACKGROUND, symbolColor: WINDOW_SYMBOL, height: 36 },
    backgroundColor: WINDOW_BACKGROUND,
    ...(app.isPackaged ? {} : { icon: DEV_WINDOW_ICON }),
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, preload },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('resize', () => {
    if (mainWindow) saveBounds(mainWindow);
  });
  mainWindow.on('move', () => {
    if (mainWindow) saveBounds(mainWindow);
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalHttp(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const ownUrl = process.env.ELECTRON_RENDERER_URL;
    if (ownUrl && url.startsWith(ownUrl)) return;
    if (!ownUrl && url.startsWith('file://')) return;
    event.preventDefault();
    if (isExternalHttp(url)) {
      void shell.openExternal(url);
    }
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await mainWindow.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  }
}

function openMainWindow(): void {
  void createWindow().catch((error: unknown) => {
    console.error('Ferry window failed to open', error);
    app.quit();
  });
}

ipcMain.handle('ferry:open-folder', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
});

ipcMain.on('ferry:connect-core', (event) => {
  transferCorePort(event.sender);
});
ipcMain.handle('ferry:engine-status', () => ({
  status: coreReady ? 'connected' : 'restarting',
  pid: corePid,
}));

ipcMain.on('ferry:theme', (_event, theme: unknown) => {
  if (!mainWindow || (theme !== 'dark' && theme !== 'light')) return;
  mainWindow.setTitleBarOverlay({
    color: theme === 'light' ? WINDOW_LIGHT_BACKGROUND : WINDOW_BACKGROUND,
    symbolColor: theme === 'light' ? WINDOW_LIGHT_SYMBOL : WINDOW_SYMBOL,
    height: 36,
  });
});

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app
  .whenReady()
  .then(() => {
    app.setAppUserModelId('dev.ferry.app');
    if (gotLock) {
      launchCore();
      if (process.env.FERRY_E2E_USER_DATA_DIR) console.log('FERRY_MAIN_READY');
      if (!process.env.FERRY_E2E_CORE_ONLY) openMainWindow();
    }
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) openMainWindow();
    });
  })
  .catch((error: unknown) => {
    console.error('Ferry failed to start', error);
    app.exit(1);
  });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  shuttingDown = true;
  if (coreRestartTimer) clearTimeout(coreRestartTimer);
  coreProcess?.kill();
  coreProcess = null;
});
