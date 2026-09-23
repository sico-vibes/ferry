import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('ferryHost', {
  platform: process.platform,
  versions: {
    app: process.env.npm_package_version ?? '0.1.0-mock',
    electron: process.versions.electron,
  },
  openFolder: (): Promise<string | null> =>
    ipcRenderer.invoke('ferry:open-folder') as Promise<string | null>,
});
