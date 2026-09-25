import { contextBridge, ipcRenderer } from 'electron';

let corePort: MessagePort | undefined;
const coreMessageHandlers = new Set<(message: unknown) => void>();

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
    ipcRenderer.send('ferry:theme', theme);
  },
  connectCore: (): Promise<void> =>
    new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        ipcRenderer.removeListener('ferry:core-port', listener);
        reject(new Error('Core connection timed out'));
      }, 12_000);
      const listener = (event: Electron.IpcRendererEvent) => {
        const port = event.ports[0];
        if (!port) return;
        clearTimeout(timeout);
        ipcRenderer.removeListener('ferry:core-port', listener);
        corePort?.close();
        corePort = port;
        corePort.addEventListener('message', (message) => {
          for (const handler of coreMessageHandlers) handler(message.data);
        });
        corePort.start();
        resolve();
      };
      ipcRenderer.on('ferry:core-port', listener);
      ipcRenderer.send('ferry:connect-core');
    }),
  sendCore: (message: unknown): void => {
    if (!corePort) throw new Error('Core connection is unavailable');
    corePort.postMessage(message);
  },
  onCoreMessage: (handler: (message: unknown) => void): (() => void) => {
    coreMessageHandlers.add(handler);
    return () => {
      coreMessageHandlers.delete(handler);
    };
  },
  closeCore: (): void => {
    corePort?.close();
    corePort = undefined;
  },
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
