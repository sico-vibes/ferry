import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
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
    if (gotLock) openMainWindow();
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
