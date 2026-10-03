import { contextBridge, ipcRenderer } from 'electron';
import { CoreHandoffTokenSchema, DesktopThemeSchema } from '@ferry/shared';
import { releaseChannelForVersion } from '../../scripts/release-config.mjs';

const releaseVersion =
  process.env.FERRY_RELEASE_VERSION ?? process.env.npm_package_version ?? '0.9.0';
const e2eDiagnosticsEnabled = Boolean(process.env.FERRY_E2E_USER_DATA_DIR);
let corePortAttempt = 0;
let backgrounded = true;
const windowBackgroundHandlers = new Set<(value: boolean) => void>();

const rendererWindow = globalThis as unknown as {
  location: { origin: string; protocol: string };
  postMessage(message: unknown, targetOrigin: string, transfer: unknown[]): void;
};
let openWorkspaceHandler: ((path: string) => void) | null = null;
let pendingWorkspacePath: string | null = null;
ipcRenderer.on('ferry:open-workspace', (_event, path: string) => {
  if (openWorkspaceHandler) openWorkspaceHandler(path);
  else pendingWorkspacePath = path;
});
ipcRenderer.on('ferry:window-background', (_event, value: boolean) => {
  backgrounded = value;
  windowBackgroundHandlers.forEach((handler) => {
    handler(value);
  });
});

contextBridge.exposeInMainWorld('ferryHost', {
  platform: process.platform,
  displayName: process.env.USERNAME?.trim() ?? process.env.USER?.trim() ?? '',
  versions: {
    app: releaseVersion,
    electron: process.versions.electron,
  },
  getAppInfo: (): Promise<{ version: string; dataDir: string }> =>
    ipcRenderer.invoke('ferry:app-info') as Promise<{ version: string; dataDir: string }>,
  channel: releaseChannelForVersion(releaseVersion).displayChannel,
  commit: process.env.FERRY_COMMIT ?? 'unknown',
  e2eDiagnosticsEnabled,
  realDomainsFromEnvironment: (): string[] =>
    process.env.FERRY_REAL_DOMAINS?.split(',')
      .map((domain) => domain.trim())
      .filter(Boolean) ?? [],
  openFolder: (): Promise<string | null> =>
    ipcRenderer.invoke('ferry:open-folder') as Promise<string | null>,
  openHelp: (): Promise<void> => ipcRenderer.invoke('ferry:open-help') as Promise<void>,
  revealDataFolder: (path: string): Promise<void> =>
    ipcRenderer.invoke('ferry:reveal-data-folder', path) as Promise<void>,
  readKeybindings: (): Promise<{ path: string; content: string; error: string | null }> =>
    ipcRenderer.invoke('ferry:keybindings-read') as Promise<{
      path: string;
      content: string;
      error: string | null;
    }>,
  writeKeybindings: (
    content: string,
  ): Promise<{ path: string; content: string; error: string | null }> =>
    ipcRenderer.invoke('ferry:keybindings-write', content) as Promise<{
      path: string;
      content: string;
      error: string | null;
    }>,
  onKeybindingsChanged: (
    handler: (value: { path: string; content: string; error: string | null }) => void,
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      value: { path: string; content: string; error: string | null },
    ) => {
      handler(value);
    };
    ipcRenderer.on('ferry:keybindings-changed', listener);
    return () => ipcRenderer.removeListener('ferry:keybindings-changed', listener);
  },
  getUpdateState: (): Promise<import('../main/update-state.js').UpdateSnapshot> =>
    ipcRenderer.invoke('ferry:update-state') as Promise<
      import('../main/update-state.js').UpdateSnapshot
    >,
  checkForUpdates: (): Promise<import('../main/update-state.js').UpdateSnapshot> =>
    ipcRenderer.invoke('ferry:update-check') as Promise<
      import('../main/update-state.js').UpdateSnapshot
    >,
  setAutoDownload: (enabled: boolean): Promise<import('../main/update-state.js').UpdateSnapshot> =>
    ipcRenderer.invoke('ferry:update-auto-download', enabled) as Promise<
      import('../main/update-state.js').UpdateSnapshot
    >,
  installUpdate: (): Promise<void> => ipcRenderer.invoke('ferry:update-install') as Promise<void>,
  downloadUpdate: (): Promise<import('../main/update-state.js').UpdateSnapshot> =>
    ipcRenderer.invoke('ferry:update-download') as Promise<
      import('../main/update-state.js').UpdateSnapshot
    >,
  onUpdateState: (
    handler: (state: import('../main/update-state.js').UpdateSnapshot) => void,
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      state: import('../main/update-state.js').UpdateSnapshot,
    ) => {
      handler(state);
    };
    ipcRenderer.on('ferry:update-state', listener);
    return () => ipcRenderer.removeListener('ferry:update-state', listener);
  },
  onOpenWorkspace: (handler: (path: string) => void): (() => void) => {
    openWorkspaceHandler = handler;
    if (pendingWorkspacePath) {
      const path = pendingWorkspacePath;
      pendingWorkspacePath = null;
      handler(path);
    }
    return () => {
      openWorkspaceHandler = null;
    };
  },
  isWindowBackgrounded: (): boolean => backgrounded,
  onWindowBackground: (handler: (backgrounded: boolean) => void): (() => void) => {
    windowBackgroundHandlers.add(handler);
    handler(backgrounded);
    return () => windowBackgroundHandlers.delete(handler);
  },
  getProcessMetrics: (): Promise<
    { role: string; pid: number; rssBytes: number; cpuPercent: number }[]
  > =>
    ipcRenderer.invoke('ferry:process-metrics') as Promise<
      { role: string; pid: number; rssBytes: number; cpuPercent: number }[]
    >,
  updateTheme: (theme: 'dark' | 'light'): void => {
    ipcRenderer.send('ferry:theme', DesktopThemeSchema.parse(theme));
  },
  connectCore: (rawToken: string): Promise<void> =>
    new Promise((resolve, reject) => {
      const attempt = ++corePortAttempt;
      const token = CoreHandoffTokenSchema.parse(rawToken);
      const timeout = setTimeout(() => {
        ipcRenderer.removeListener('ferry:core-port', listener);
        reject(new Error('Core connection timed out'));
      }, 12_000);
      const listener = (
        event: Electron.IpcRendererEvent,
        metadata?: { type?: string; portId?: string },
      ) => {
        const port = event.ports[0];
        if (!port) return;
        clearTimeout(timeout);
        ipcRenderer.removeListener('ferry:core-port', listener);
        if (e2eDiagnosticsEnabled)
          console.info(
            `FERRY_PRELOAD_PORT_RECEIVED ${JSON.stringify({ attempt, portId: metadata?.portId ?? 'missing', portCount: event.ports.length })}`,
          );
        const origin = rendererWindow.location.origin;
        const targetOrigin =
          origin === 'null' || rendererWindow.location.protocol === 'file:' ? '*' : origin;
        rendererWindow.postMessage({ type: 'ferry:core-port' }, targetOrigin, [port]);
        if (e2eDiagnosticsEnabled)
          console.info(
            `FERRY_PRELOAD_PORT_FORWARDED ${JSON.stringify({ attempt, portId: metadata?.portId ?? 'missing', targetOrigin })}`,
          );
        resolve();
      };
      ipcRenderer.on('ferry:core-port', listener);
      if (e2eDiagnosticsEnabled)
        console.info(`FERRY_PRELOAD_CONNECT_LISTENER ${JSON.stringify({ attempt })}`);
      ipcRenderer.send('ferry:connect-core', token);
    }),
  getEngineStatus: (): Promise<{
    status: 'connected' | 'restarting';
    pid?: number | null;
  }> =>
    ipcRenderer.invoke('ferry:engine-status') as Promise<{
      status: 'connected' | 'restarting';
      pid?: number | null;
    }>,
  onEngineRestarting: (handler: () => void): (() => void) => {
    const listener = () => {
      handler();
    };
    ipcRenderer.on('ferry:engine-restarting', listener);
    return () => {
      ipcRenderer.removeListener('ferry:engine-restarting', listener);
    };
  },
  onEngineConnected: (handler: () => void): (() => void) => {
    const listener = () => {
      handler();
    };
    ipcRenderer.on('ferry:engine-connected', listener);
    return () => {
      ipcRenderer.removeListener('ferry:engine-connected', listener);
    };
  },
});
