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
import { existsSync, readFileSync, watch, writeFileSync } from 'node:fs';
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CoreHandoffTokenSchema,
  DesktopThemeSchema,
  EmptyIpcArgsSchema,
  FERRY_DOMAINS,
  OpenFolderResultSchema,
} from '@ferry/shared';
import { canonicalizePath } from '@ferry/shared/node-paths';
import {
  WINDOW_BACKGROUND,
  WINDOW_LIGHT_BACKGROUND,
  WINDOW_LIGHT_SYMBOL,
  WINDOW_SYMBOL,
} from './window-theme.js';
import { buildCoreEnvironment } from './core-environment.js';
import { isTrustedRendererOrigin } from './renderer-origin.js';
import { isAllowlistedExternal } from './external-links.js';
import { UpdateController, type UpdateSnapshot } from './update-state.js';
import { releaseChannelForVersion } from '../../scripts/release-config.mjs';

const { autoUpdater } = updater;
const releaseChannel = releaseChannelForVersion(
  process.env.FERRY_RELEASE_VERSION ?? app.getVersion(),
);

// Keep a standalone icon resource for BrowserWindow in packaged builds.
const DEV_WINDOW_ICON = join(import.meta.dirname, '../../build/icon.ico');

app.setName('Ferry');
if (process.platform === 'win32') app.setAppUserModelId('dev.ferry.app');
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
let windowBackgrounded = true;
let saveTimer: NodeJS.Timeout | undefined;
let coreProcess: UtilityProcess | null = null;
let corePid: number | null = null;
let coreReady = false;
let coreListening = false;
let restartCount = 0;
let coreRestartTimer: NodeJS.Timeout | undefined;
let shuttingDown = false;
let shutdownComplete = false;
let updateInstallStarted = false;
interface PendingCoreConnector {
  sender: Electron.WebContents;
  connectId: number;
}
const coreConnectors: PendingCoreConnector[] = [];
let coreGeneration = 0;
let nextCorePortId = 0;
let nextCoreConnectId = 0;
const installSmoke = process.env.FERRY_INSTALL_SMOKE === 'true';
const e2eTracing = Boolean(process.env.FERRY_E2E_USER_DATA_DIR) || installSmoke;
function traceCore(event: string, details: Record<string, unknown>): void {
  if (e2eTracing) console.log(`FERRY_HANDOFF ${JSON.stringify({ event, ...details })}`);
}
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

function publishWindowBackground(backgrounded: boolean): void {
  windowBackgrounded = backgrounded;
  coreProcess?.postMessage({ type: 'ferry:ui-active', active: !backgrounded });
  for (const window of BrowserWindow.getAllWindows())
    window.webContents.send('ferry:window-background', backgrounded);
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

function isTrustedRendererUrl(url: string): boolean {
  try {
    const devUrl = process.env.ELECTRON_RENDERER_URL;
    const rendererFile = pathToFileURL(join(import.meta.dirname, '../renderer/index.html'));
    return isTrustedRendererOrigin(url, devUrl, rendererFile.toString());
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
    isTrustedRendererUrl(frame.url),
  );
}
async function openExternalSafely(url: string): Promise<void> {
  if (!isAllowlistedExternal(url)) return;
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

function transferCorePort(sender: Electron.WebContents, connectId: number): void {
  if (sender.isDestroyed()) return;
  if (!coreProcess || !coreListening) {
    coreConnectors.push({ sender, connectId });
    traceCore('queued', {
      connectId,
      webContentsId: sender.id,
      reason: !coreProcess ? 'utility-unavailable' : 'waiting-for-core-listening',
    });
    return;
  }
  const portId = `core-${String(coreGeneration)}-port-${String(++nextCorePortId)}`;
  const channel = new MessageChannelMain();
  const frame = sender.mainFrame;
  traceCore('channel-created', {
    connectId,
    portId,
    coreGeneration,
    utilityPid: coreProcess.pid ?? corePid,
    webContentsId: sender.id,
    frameRoutingId: frame.routingId,
    frameUrl: frame.url,
  });
  coreProcess.postMessage({ type: 'ferry:attach' }, [channel.port1]);
  traceCore('port-posted-to-utility', { connectId, portId, coreGeneration });
  sender.postMessage('ferry:core-port', { type: 'ferry:core-port', portId }, [channel.port2]);
  traceCore('port-posted-to-renderer', {
    connectId,
    portId,
    webContentsId: sender.id,
    frameRoutingId: frame.routingId,
    frameUrl: frame.url,
  });
}

function launchCore(): void {
  if (shuttingDown) return;
  coreGeneration += 1;
  const generation = coreGeneration;
  const coreEntry = canonicalizePath(join(import.meta.dirname, 'core-entry.js'));
  const coreEnvironment = buildCoreEnvironment(process.env, app.isPackaged);
  coreEnvironment.FERRY_REAL_DOMAINS ??= FERRY_DOMAINS.join(',');
  coreEnvironment.FERRY_CORE_DATA_DIR =
    coreEnvironment.FERRY_DATA_DIR ??
    coreEnvironment.FERRY_HOME ??
    join(app.getPath('userData'), 'engine');
  delete coreEnvironment.FERRY_DATA_DIR;
  delete coreEnvironment.FERRY_HOME;
  coreEnvironment.FERRY_LOG_DIRECT = 'true';
  const child = utilityProcess.fork(coreEntry, [], {
    serviceName: 'Ferry Core',
    env: coreEnvironment,
    stdio: e2eTracing ? 'pipe' : 'inherit',
  });
  if (e2eTracing)
    child.stderr?.on('data', (chunk: unknown) => {
      console.error('FERRY_CORE_STDERR ' + String(chunk));
    });
  coreProcess = child;
  corePid = child.pid ?? null;
  coreReady = false;
  coreListening = false;
  traceCore('respawned', { coreGeneration: generation, utilityPid: child.pid ?? null });
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
      traceCore('core-listening', { coreGeneration: generation, utilityPid: child.pid ?? null });
      for (const connector of coreConnectors.splice(0))
        transferCorePort(connector.sender, connector.connectId);
      if (process.env.FERRY_E2E_CORE_ONLY) {
        const channel = new MessageChannelMain();
        traceCore('e2e-core-only-channel-created', { coreGeneration: generation });
        child.postMessage({ type: 'ferry:attach' }, [channel.port1]);
        channel.port2.on('message', (event) => {
          if (e2eTracing) console.error('FERRY_CORE_MESSAGE ' + JSON.stringify(event.data));
        });
        channel.port2.start();
      }
      return;
    }
    if (message.type !== 'ferry:core-ready') return;
    if (process.env.FERRY_E2E_USER_DATA_DIR && 'pid' in message && typeof message.pid === 'number')
      corePid = message.pid;
    coreReady = true;
    restartCount = 0;
    broadcastEngineConnected();
    traceCore('core-ready', { coreGeneration: generation, utilityPid: corePid });
    if (process.env.FERRY_E2E_USER_DATA_DIR && 'selfTest' in message)
      console.log(`FERRY_CORE_READY ${JSON.stringify(message)}`);
  });
  child.on('exit', (code) => {
    handleCoreExit(child, code);
  });
  child.on('spawn', () => {
    corePid = child.pid ?? null;
    child.postMessage({ type: 'ferry:ui-active', active: !windowBackgrounded });
    if (process.env.FERRY_E2E_USER_DATA_DIR)
      console.log(
        `FERRY_UTILITY_SPAWN ${JSON.stringify({ coreGeneration: generation, pid: corePid })}`,
      );
    traceCore('utility-spawn', { coreGeneration: generation, utilityPid: corePid });
  });
}

function handleCoreExit(child: UtilityProcess, code: number | null): void {
  if (process.env.FERRY_E2E_USER_DATA_DIR)
    console.error(`FERRY_CORE_EXIT ${JSON.stringify({ coreGeneration, pid: child.pid, code })}`);
  traceCore('utility-exit', { coreGeneration, utilityPid: child.pid ?? null, code });
  if (coreProcess !== child || shuttingDown) return;
  coreProcess = null;
  corePid = null;
  coreReady = false;
  coreListening = false;
  restartCount += 1;
  broadcastEngineRestarting();
  if (coreRestartTimer) clearTimeout(coreRestartTimer);
  const delay = Math.min(500 * 2 ** Math.min(restartCount - 1, 5), 15_000);
  coreRestartTimer = setTimeout(launchCore, delay);
}

function utilityProcessIsAlive(child: UtilityProcess): boolean {
  const pid = child.pid;
  if (typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
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
    titleBarOverlay: { color: WINDOW_BACKGROUND, symbolColor: WINDOW_SYMBOL, height: 44 },
    backgroundColor: WINDOW_BACKGROUND,
    icon: app.isPackaged ? join(process.resourcesPath, 'app-icon.ico') : DEV_WINDOW_ICON,
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

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });
  mainWindow.on('show', () => {
    publishWindowBackground(false);
  });
  mainWindow.on('focus', () => {
    publishWindowBackground(false);
  });
  mainWindow.on('blur', () => {
    publishWindowBackground(true);
  });
  mainWindow.on('hide', () => {
    publishWindowBackground(true);
  });
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

ipcMain.handle('ferry:open-help', (event, ...args: unknown[]) => {
  if (!isTrustedSender(event)) throw new Error('Untrusted IPC sender');
  EmptyIpcArgsSchema.parse(args);
  return openExternalSafely('https://github.com/sico-vibes/ferry#readme');
});

ipcMain.handle('ferry:app-info', (event, ...args: unknown[]) => {
  if (!isTrustedSender(event)) throw new Error('Untrusted IPC sender');
  EmptyIpcArgsSchema.parse(args);
  return { version: app.getVersion(), dataDir: app.getPath('userData') };
});

ipcMain.handle('ferry:reveal-data-folder', (event, rawPath: unknown) => {
  if (!isTrustedSender(event)) throw new Error('Untrusted IPC sender');
  const path = OpenFolderResultSchema.parse(rawPath);
  if (!path) throw new Error('Invalid data folder request');
  shell.showItemInFolder(path);
});

const keybindingsPath = join(app.getPath('userData'), 'keybindings.json');
const readKeybindings = async (): Promise<{
  path: string;
  content: string;
  error: string | null;
}> => {
  try {
    return { path: keybindingsPath, content: await readFile(keybindingsPath, 'utf8'), error: null };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const content =
      JSON.stringify(
        { $schema: 'https://ferry.dev/schemas/keybindings.json', bindings: [] },
        null,
        2,
      ) + '\n';
    await writeFile(keybindingsPath, content, 'utf8');
    return { path: keybindingsPath, content, error: null };
  }
};
ipcMain.handle('ferry:keybindings-read', async (event, ...args: unknown[]) => {
  if (!isTrustedSender(event)) throw new Error('Untrusted IPC sender');
  EmptyIpcArgsSchema.parse(args);
  return readKeybindings();
});
ipcMain.handle('ferry:keybindings-write', async (event, content: unknown) => {
  if (!isTrustedSender(event) || typeof content !== 'string')
    throw new Error('Invalid keybindings request');
  await mkdir(join(app.getPath('userData')), { recursive: true });
  await writeFile(keybindingsPath, content, 'utf8');
  return readKeybindings();
});
let keybindingsWatcher: ReturnType<typeof watch> | undefined;
const watchKeybindings = () => {
  keybindingsWatcher?.close();
  keybindingsWatcher = watch(join(app.getPath('userData')), (_event, filename) => {
    if (filename?.toString() !== 'keybindings.json' || !mainWindow) return;
    void readFile(keybindingsPath, 'utf8')
      .then((content) => {
        mainWindow?.webContents.send('ferry:keybindings-changed', {
          path: keybindingsPath,
          content,
          error: null,
        });
      })
      .catch(() => undefined);
  });
};

const consumedHandoffTokens = new Set<string>();
ipcMain.on('ferry:connect-core', (event, rawToken: unknown) => {
  if (!isTrustedSender(event)) {
    return;
  }
  const token = CoreHandoffTokenSchema.safeParse(rawToken);
  if (!token.success || consumedHandoffTokens.has(token.data)) return;
  consumedHandoffTokens.add(token.data);
  const connectId = ++nextCoreConnectId;
  const frame = event.senderFrame;
  traceCore('connect-request', {
    connectId,
    webContentsId: event.sender.id,
    frameRoutingId: frame?.routingId,
    frameIsMain: frame === event.sender.mainFrame,
    frameUrl: frame?.url,
  });
  transferCorePort(event.sender, connectId);
});
ipcMain.handle('ferry:engine-status', (event, ...args: unknown[]) => {
  if (!isTrustedSender(event)) throw new Error('Untrusted IPC sender');
  EmptyIpcArgsSchema.parse(args);
  if (coreReady && coreProcess && !utilityProcessIsAlive(coreProcess))
    handleCoreExit(coreProcess, null);
  const processId = coreProcess?.pid ?? null;
  const status = { status: coreReady && processId !== null ? 'connected' : 'restarting' };
  return process.env.FERRY_E2E_USER_DATA_DIR
    ? { ...status, ...(processId !== null ? { pid: processId } : {}) }
    : status;
});
ipcMain.handle('ferry:process-metrics', (event, ...args: unknown[]) => {
  if (!isTrustedSender(event)) throw new Error('Untrusted IPC sender');
  EmptyIpcArgsSchema.parse(args);
  const rendererPid = mainWindow?.webContents.getOSProcessId();
  const metrics = app.getAppMetrics();
  return metrics.flatMap((metric) => {
    const role =
      metric.pid === process.pid
        ? 'main'
        : metric.pid === rendererPid
          ? 'renderer'
          : metric.pid === corePid
            ? 'core'
            : null;
    return role
      ? [
          {
            role,
            pid: metric.pid,
            rssBytes: metric.memory.workingSetSize * 1024,
            cpuPercent: metric.cpu.percentCPUUsage,
          },
        ]
      : [];
  });
});

ipcMain.on('ferry:theme', (event, rawTheme: unknown) => {
  if (!isTrustedSender(event)) return;
  const parsed = DesktopThemeSchema.safeParse(rawTheme);
  if (!mainWindow || !parsed.success) return;
  const theme = parsed.data;
  mainWindow.setTitleBarOverlay({
    color: theme === 'light' ? WINDOW_LIGHT_BACKGROUND : WINDOW_BACKGROUND,
    symbolColor: theme === 'light' ? WINDOW_LIGHT_SYMBOL : WINDOW_SYMBOL,
    height: 44,
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
  if (updateController.getSnapshot().status === 'downloaded') app.quit();
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
    await mkdir(app.getPath('userData'), { recursive: true });
    watchKeybindings();
    updateController.setAutoDownload(readAutoDownloadPreference());
    autoUpdater.autoDownload = readAutoDownloadPreference();
    if (app.isPackaged && !e2eUserDataPath) {
      autoUpdater.channel = releaseChannel.updaterChannel;
      autoUpdater.allowPrerelease = releaseChannel.allowPrerelease;
      autoUpdater.autoDownload = updateController.getSnapshot().autoDownload;
      (autoUpdater as NsisUpdater).verifyUpdateCodeSignature = () => Promise.resolve(null);
      if (!installSmoke) {
        void updateController.check();
        setInterval(() => void updateController.check(), 6 * 60 * 60 * 1000).unref();
      }
    }
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => {
      callback(false);
    });
    session.defaultSession.setPermissionCheckHandler(() => false);
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

app.on('before-quit', (event) => {
  if (updateController.getSnapshot().status === 'downloaded' && !updateInstallStarted) {
    event.preventDefault();
    updateInstallStarted = true;
    if (shutdownComplete || !coreProcess) {
      updateController.install();
      return;
    }
  }
  if (shutdownComplete || !coreProcess) {
    shuttingDown = true;
    return;
  }
  if (shuttingDown) {
    event.preventDefault();
    return;
  }
  event.preventDefault();
  shuttingDown = true;
  if (coreRestartTimer) clearTimeout(coreRestartTimer);
  const child = coreProcess;
  const fallback = setTimeout(() => child.kill(), 8_000);
  child.once('exit', () => {
    clearTimeout(fallback);
    coreProcess = null;
    shutdownComplete = true;
    if (updateInstallStarted) updateController.install();
    else app.quit();
  });
  child.postMessage({ type: 'ferry:shutdown' });
});
