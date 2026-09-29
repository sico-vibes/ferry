import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { UpdateController, type UpdateSource } from './update-state';

class FakeUpdater extends EventEmitter implements UpdateSource {
  autoDownload = false;
  checkForUpdates = vi.fn(() => Promise.resolve(undefined));
  downloadUpdate = vi.fn(() => Promise.resolve(undefined));
  quitAndInstall = vi.fn();
}

describe('UpdateController', () => {
  it('defaults to auto-download and publishes available then downloaded state', () => {
    const updater = new FakeUpdater();
    const updates = new UpdateController(updater);
    const states: string[] = [];
    updates.subscribe((state) => states.push(state.status));

    updater.emit('update-available', { version: '0.9.1' });
    expect(updates.getSnapshot()).toMatchObject({ status: 'available', version: '0.9.1' });
    updater.emit('update-downloaded', { version: '0.9.1' });
    updates.install();

    expect(states).toEqual(['available', 'downloaded']);
    expect(updater.quitAndInstall).toHaveBeenCalledOnce();
  });

  it('checks on request and captures updater errors', async () => {
    const updater = new FakeUpdater();
    updater.checkForUpdates.mockRejectedValueOnce(new Error('offline'));
    const updates = new UpdateController(updater);

    await updates.check();

    expect(updater.checkForUpdates).toHaveBeenCalledOnce();
    expect(updates.getSnapshot()).toMatchObject({ status: 'error', error: 'offline' });
  });

  it('does not install before a package has downloaded and supports disabling auto-download', () => {
    const updater = new FakeUpdater();
    const updates = new UpdateController(updater);

    updates.install();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    expect(updates.setAutoDownload(false).autoDownload).toBe(false);
    expect(updater.autoDownload).toBe(false);
  });

  it('downloads an available update when automatic downloads are disabled', async () => {
    const updater = new FakeUpdater();
    const updates = new UpdateController(updater);
    updates.setAutoDownload(false);
    updater.emit('update-available', { version: '0.9.1' });

    await updates.download();

    expect(updater.downloadUpdate).toHaveBeenCalledOnce();
  });
});
