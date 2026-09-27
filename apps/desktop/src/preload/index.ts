import { contextBridge, ipcRenderer } from 'electron';
import { CoreHandoffTokenSchema, DesktopThemeSchema } from '@ferry/shared';

const rendererWindow = globalThis as unknown as {
  location: { origin: string; protocol: string };
  postMessage(message: unknown, targetOrigin: string, transfer: unknown[]): void;
};

contextBridge.exposeInMainWorld('ferryHost', {
  platform: process.platform,
  versions: {
    app: process.env.npm_package_version ?? '0.1.0-mock',
    electron: process.versions.electron,
  },
  realDomainsFromEnvironment: (): string[] =>
    process.env.FERRY_REAL_DOMAINS?.split(',')
      .map((domain) => domain.trim())
      .filter(Boolean) ?? [],
  openFolder: (): Promise<string | null> =>
    ipcRenderer.invoke('ferry:open-folder') as Promise<string | null>,
  updateTheme: (theme: 'dark' | 'light'): void => {
    ipcRenderer.send('ferry:theme', DesktopThemeSchema.parse(theme));
  },
  connectCore: (rawToken: string): Promise<void> =>
    new Promise((resolve, reject) => {
      const token = CoreHandoffTokenSchema.parse(rawToken);
      const timeout = setTimeout(() => {
        ipcRenderer.removeListener('ferry:core-port', listener);
        reject(new Error('Core connection timed out'));
      }, 12_000);
      const listener = (event: Electron.IpcRendererEvent) => {
        const port = event.ports[0];
        if (!port) return;
        clearTimeout(timeout);
        ipcRenderer.removeListener('ferry:core-port', listener);
        const origin = rendererWindow.location.origin;
        const targetOrigin =
          origin === 'null' || rendererWindow.location.protocol === 'file:' ? '*' : origin;
        rendererWindow.postMessage({ type: 'ferry:core-port', token }, targetOrigin, [port]);
        resolve();
      };
      ipcRenderer.on('ferry:core-port', listener);
      ipcRenderer.send('ferry:connect-core', token);
    }),
  getEngineStatus: (): Promise<{ status: 'connected' | 'restarting'; pid: number | null }> =>
    ipcRenderer.invoke('ferry:engine-status') as Promise<{
      status: 'connected' | 'restarting';
      pid: number | null;
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
