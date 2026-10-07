export type UpdateStatus =
  'idle' | 'checking' | 'available' | 'downloaded' | 'not-available' | 'error';

export interface UpdateSnapshot {
  status: UpdateStatus;
  version: string | null;
  error: string | null;
  autoDownload: boolean;
}

export interface UpdateSource {
  autoDownload: boolean;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(event: string, listener: (...args: unknown[]) => void): this;
}

export class UpdateController {
  private snapshot: UpdateSnapshot = {
    status: 'idle',
    version: null,
    error: null,
    autoDownload: true,
  };
  private readonly listeners = new Set<(snapshot: UpdateSnapshot) => void>();

  constructor(private readonly source: UpdateSource) {
    source.autoDownload = this.snapshot.autoDownload;
    source.on('checking-for-update', () => {
      this.patch({ status: 'checking', error: null });
    });
    source.on('update-available', (info) => {
      this.patch({ status: 'available', version: this.getVersion(info), error: null });
    });
    source.on('update-not-available', () => {
      this.patch({ status: 'not-available', version: null, error: null });
    });
    source.on('update-downloaded', (info) => {
      this.patch({
        status: 'downloaded',
        version: this.getVersion(info),
        error: null,
      });
    });
    source.on('error', (error) => {
      this.patch({
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  getSnapshot(): UpdateSnapshot {
    return { ...this.snapshot };
  }

  subscribe(listener: (snapshot: UpdateSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async check(): Promise<void> {
    this.patch({ status: 'checking', error: null });
    try {
      await this.source.checkForUpdates();
    } catch (error) {
      this.patch({
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  setAutoDownload(enabled: boolean): UpdateSnapshot {
    this.source.autoDownload = enabled;
    this.patch({ autoDownload: enabled });
    return this.getSnapshot();
  }

  async download(): Promise<void> {
    if (this.snapshot.status !== 'available' || this.snapshot.autoDownload) return;
    try {
      await this.source.downloadUpdate();
    } catch (error) {
      this.patch({
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  install(): boolean {
    if (this.snapshot.status !== 'downloaded') {
      this.fail('The update is no longer ready to install. Download it again.');
      return false;
    }
    try {
      this.source.quitAndInstall(true, true);
      return this.getSnapshot().status === 'downloaded';
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  fail(message: string): void {
    this.patch({ status: 'error', error: message });
  }

  private getVersion(info: unknown): string | null {
    if (typeof info !== 'object' || info === null || !('version' in info)) return null;
    return typeof info.version === 'string' ? info.version : null;
  }

  private patch(patch: Partial<UpdateSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener(this.getSnapshot());
  }
}
