import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  MessageChannelMain,
  shell,
  session,
  utilityProcess,
  type UtilityProcess,
} from 'electron';
import updater, { type NsisUpdater } from 'electron-updater';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { access, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CoreHandoffTokenSchema,
  DesktopThemeSchema,
  EmptyIpcArgsSchema,
  FERRY_DOMAINS,
  OpenFolderResultSchema,
} from '@ferry/shared';
import {
  WINDOW_BACKGROUND,
  WINDOW_LIGHT_BACKGROUND,
  WINDOW_LIGHT_SYMBOL,
  WINDOW_SYMBOL,
} from './window-theme.js';
import { buildCoreEnvironment } from './core-environment.js';
import { isTrustedRendererOrigin } from './renderer-origin.js';
import { UpdateController, type UpdateSnapshot } from './update-state.js';
import { releaseChannelForVersion } from '../../scripts/release-config.mjs';

const { autoUpdater } = updater;
const releaseChannel = releaseChannelForVersion(
  process.env.FERRY_RELEASE_VERSION ?? app.getVersion(),
);

// Packaged builds use the icon embedded in the .exe by electron-builder (build/icon.ico).
const DEV_WINDOW_ICON = join(import.meta.dirname, '../../build/icon.ico');

app.setName('Ferry');
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
let coreListening = false;
let restartCount = 0;
let coreRestartTimer: NodeJS.Timeout | undefined;
let shuttingDown = false;
const coreConnectors: Electron.WebContents[] = [];
const updateController = new UpdateController(autoUpdater);
let pendingWorkspacePath: string | null = findWorkspaceArgument(process.argv);

function findWorkspaceArgument(args: string[]): string | null {
  const index = args.indexOf('--open-folder');
  return index >= 0 ? (args[index + 1] ?? null) : null;
}

function publishWorkspacePath(path: string | null): void {
  if (!path || !mainWindow || mainWindow.webContents.isLoading()) {
    if (path) pendingWorkspacePath = path;
    return;
  }
  pendingWorkspacePath = null;
  mainWindow.webContents.send('ferry:open-workspace', path);
}

function publishUpdateState(state: UpdateSnapshot): void {
  for (const window of BrowserWindow.getAllWindows())
    window.webContents.send('ferry:update-state', state);
}
updateController.subscribe(publishUpdateState);

const updatePreferencePath = (): string => join(app.getPath('userData'), 'updates.json');

function readAutoDownloadPreference(): boolean {
  try {
    const value: unknown = JSON.parse(readFileSync(updatePreferencePath(), 'utf8'));
    return typeof value === 'object' && value !== null && 'autoDownload' in value
      ? value.autoDownload !== false
      : true;
  } catch {
    return true;
  }
}

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
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

const externalDomainAllowlist = new Set([
  'docs.ferry.dev',
  'github.com',
  'docs.github.com',
  'openai.com',
  'platform.openai.com',
  'anthropic.com',
  'console.anthropic.com',
  'ai.google.dev',
  'console.groq.com',
  'openrouter.ai',
  'docs.mistral.ai',
  'huggingface.co',
  'docs.deepseek.com',
]);
function isAllowlistedExternal(url: string): boolean {
  if (!isExternalHttp(url)) return false;
  const hostname = new URL(url).hostname.toLowerCase();
  return [...externalDomainAllowlist].some(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
  );
}
function isTrustedRendererUrl(url: string): boolean {
  try {
    const actual = new URL(url);
    const devUrl = process.env.ELECTRON_RENDERER_URL;
    if (devUrl) {
      const expected = new URL(devUrl);
      return actual.origin === expected.origin && actual.pathname === expected.pathname;
    }
    const rendererFile = pathToFileURL(join(import.meta.dirname, '../renderer/index.html'));
    return actual.protocol === 'file:' && actual.pathname === rendererFile.pathname;
  } catch {
    return false;
  }
}
function isTrustedSender(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  return Boolean(
    mainWindow &&
    !event.sender.isDestroyed() &&
    event.sender === mainWindow.webContents &&
    frame &&
    frame === event.sender.mainFrame &&
    isTrustedRendererOrigin(frame.url, process.env.ELECTRON_RENDERER_URL),
  );
}
async function openExternalSafely(url: string): Promise<void> {
  if (!isExternalHttp(url)) return;
  if (!isAllowlistedExternal(url)) {
    const options: Electron.MessageBoxOptions = {
      type: 'question',
      buttons: ['Open link', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: 'Open this link in your browser?',
      detail: new URL(url).hostname,
    };
    const choice = mainWindow
      ? await dialog.showMessageBox(mainWindow, options)
      : await dialog.showMessageBox(options);
    if (choice.response !== 0) return;
  }
  await shell.openExternal(url);
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
  if (!coreProcess || !coreListening) {
    coreConnectors.push(sender);
    return;
  }
  const channel = new MessageChannelMain();
  coreProcess.postMessage({ type: 'ferry:attach' }, [channel.port1]);
  sender.postMessage('ferry:core-port', { type: 'ferry:core-port' }, [channel.port2]);
}

function launchCore(): void {
  if (shuttingDown) return;
  const coreEntry = join(import.meta.dirname, 'core-entry.js');
  const coreEnvironment = buildCoreEnvironment(process.env, app.isPackaged);
  coreEnvironment.FERRY_REAL_DOMAINS ??= FERRY_DOMAINS.join(',');
  coreEnvironment.FERRY_CORE_DATA_DIR =
    coreEnvironment.FERRY_HOME ?? join(app.getPath('userData'), 'engine');
  delete coreEnvironment.FERRY_HOME;
  coreEnvironment.FERRY_LOG_DIRECT = 'true';
  const child = utilityProcess.fork(coreEntry, [], {
    serviceName: 'Ferry Core',
    env: coreEnvironment,
    stdio: process.env.FERRY_E2E_USER_DATA_DIR ? 'pipe' : 'inherit',
  });
  if (process.env.FERRY_E2E_USER_DATA_DIR)
    child.stderr?.on('data', (chunk: unknown) => {
      console.error('FERRY_CORE_STDERR ' + String(chunk));
    });
  coreProcess = child;
  corePid = child.pid ?? null;
  coreReady = false;
  coreListening = false;
  child.on('message', (message: unknown) => {
    if (
      coreProcess !== child ||
      typeof message !== 'object' ||
      message === null ||
      !('type' in message)
    )
      return;
    if (message.type === 'ferry:core-listening') {
      coreListening = true;
      for (const sender of coreConnectors.splice(0)) transferCorePort(sender);
      if (process.env.FERRY_E2E_CORE_ONLY) {
        const channel = new MessageChannelMain();
        child.postMessage({ type: 'ferry:attach' }, [channel.port1]);
        channel.port2.on('message', (event) => {
          if (process.env.FERRY_E2E_USER_DATA_DIR)
            console.error('FERRY_CORE_MESSAGE ' + JSON.stringify(event.data));
        });
        channel.port2.start();
      }
      return;
    }
    if (message.type !== 'ferry:core-ready') return;
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
    coreListening = false;
    restartCount += 1;
    broadcastEngineRestarting();
    const delay = Math.min(500 * 2 ** Math.min(restartCount - 1, 5), 15_000);
    coreRestartTimer = setTimeout(launchCore, delay);
  });
  child.on('spawn', () => {
    if (process.env.FERRY_E2E_USER_DATA_DIR) console.log('FERRY_UTILITY_SPAWN');
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
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      devTools: !app.isPackaged || process.env.FERRY_DEBUG_TOOLS === '1',
      preload,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('resize', () => {
    if (mainWindow) saveBounds(mainWindow);
  });
  mainWindow.on('move', () => {
    if (mainWindow) saveBounds(mainWindow);
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalSafely(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isTrustedRendererUrl(url)) return;
    event.preventDefault();
    void openExternalSafely(url);
  });
  mainWindow.webContents.on('will-redirect', (event, url) => {
    if (isTrustedRendererUrl(url)) return;
    event.preventDefault();
    void openExternalSafely(url);
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await mainWindow.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  }
  publishWorkspacePath(pendingWorkspacePath);
  mainWindow.webContents.on('did-finish-load', () => {
    publishWorkspacePath(pendingWorkspacePath);
  });
}

function openMainWindow(): void {
  void createWindow().catch((error: unknown) => {
    console.error('Ferry window failed to open', error);
    app.quit();
  });
}

ipcMain.handle('ferry:open-folder', async (event, ...args: unknown[]) => {
  if (!isTrustedSender(event)) throw new Error('Untrusted IPC sender');
  EmptyIpcArgsSchema.parse(args);
  if (!app.isPackaged && process.env.FERRY_E2E_USER_DATA_DIR && process.env.FERRY_E2E_OPEN_FOLDER)
    return OpenFolderResultSchema.parse(process.env.FERRY_E2E_OPEN_FOLDER);
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });
  return OpenFolderResultSchema.parse(result.canceled ? null : (result.filePaths[0] ?? null));
});

const consumedHandoffTokens = new Set<string>();
ipcMain.on('ferry:connect-core', (event, rawToken: unknown) => {
  if (!isTrustedSender(event)) {
    return;
  }
  const token = CoreHandoffTokenSchema.safeParse(rawToken);
  if (!token.success || consumedHandoffTokens.has(token.data)) return;
  consumedHandoffTokens.add(token.data);
  transferCorePort(event.sender);
});
ipcMain.handle('ferry:engine-status', (event, ...args: unknown[]) => {
  if (!isTrustedSender(event)) throw new Error('Untrusted IPC sender');
  EmptyIpcArgsSchema.parse(args);
  return { status: coreReady ? 'connected' : 'restarting', pid: corePid };
});

ipcMain.on('ferry:theme', (event, rawTheme: unknown) => {
  if (!isTrustedSender(event)) return;
  const parsed = DesktopThemeSchema.safeParse(rawTheme);
  if (!mainWindow || !parsed.success) return;
  const theme = parsed.data;
  mainWindow.setTitleBarOverlay({
    color: theme === 'light' ? WINDOW_LIGHT_BACKGROUND : WINDOW_BACKGROUND,
    symbolColor: theme === 'light' ? WINDOW_LIGHT_SYMBOL : WINDOW_SYMBOL,
    height: 36,
  });
});

app.on('second-instance', (_event, argv) => {
  const workspacePath = findWorkspaceArgument(argv);
  if (workspacePath) pendingWorkspacePath = workspacePath;
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    publishWorkspacePath(pendingWorkspacePath);
  }
});

ipcMain.handle('ferry:update-state', (event, ...args: unknown[]) => {
  if (!isTrustedSender(event)) throw new Error('Untrusted IPC sender');
  EmptyIpcArgsSchema.parse(args);
  return updateController.getSnapshot();
});
ipcMain.handle('ferry:update-check', async (event, ...args: unknown[]) => {
  if (!isTrustedSender(event)) throw new Error('Untrusted IPC sender');
  EmptyIpcArgsSchema.parse(args);
  await updateController.check();
  return updateController.getSnapshot();
});
ipcMain.handle('ferry:update-auto-download', (event, enabled: unknown) => {
  if (!isTrustedSender(event) || typeof enabled !== 'boolean')
    throw new Error('Invalid update preference request');
  const snapshot = updateController.setAutoDownload(enabled);
  writeFileSync(updatePreferencePath(), JSON.stringify({ autoDownload: enabled }), 'utf8');
  return snapshot;
});
ipcMain.handle('ferry:update-install', (event, ...args: unknown[]) => {
  if (!isTrustedSender(event)) throw new Error('Untrusted IPC sender');
  EmptyIpcArgsSchema.parse(args);
  updateController.install();
});
ipcMain.handle('ferry:update-download', async (event, ...args: unknown[]) => {
  if (!isTrustedSender(event)) throw new Error('Untrusted IPC sender');
  EmptyIpcArgsSchema.parse(args);
  await updateController.download();
  return updateController.getSnapshot();
});

app
  .whenReady()
  .then(async () => {
    updateController.setAutoDownload(readAutoDownloadPreference());
    autoUpdater.autoDownload = readAutoDownloadPreference();
    if (app.isPackaged && !e2eUserDataPath) {
      autoUpdater.channel = releaseChannel.updaterChannel;
      autoUpdater.allowPrerelease = releaseChannel.allowPrerelease;
      autoUpdater.autoDownload = updateController.getSnapshot().autoDownload;
      (autoUpdater as NsisUpdater).verifyUpdateCodeSignature = () => Promise.resolve(null);
      void updateController.check();
      setInterval(() => void updateController.check(), 6 * 60 * 60 * 1000).unref();
    }
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => {
      callback(false);
    });
    if (app.isPackaged && !e2eUserDataPath) {
      const oldUserData = join(app.getPath('appData'), '@ferry', 'desktop');
      const newUserData = app.getPath('userData');
      const oldEntries = await readdir(oldUserData).catch(() => []);
      if (oldEntries.length) {
        await mkdir(newUserData, { recursive: true });
        for (const entry of oldEntries) {
          const source = join(oldUserData, entry);
          const destination = join(newUserData, entry);
          const destinationExists = await access(destination).then(
            () => true,
            () => false,
          );
          if (!destinationExists) await rename(source, destination);
        }
        await rm(oldUserData, { recursive: false }).catch(() => undefined);
      }
    }
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
