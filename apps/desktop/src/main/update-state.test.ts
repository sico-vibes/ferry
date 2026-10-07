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
  it('publishes an error and stays alive when quitAndInstall throws', () => {
    const updater = new FakeUpdater();
    const updates = new UpdateController(updater);
    const listener = vi.fn();
    updates.subscribe(listener);
    updater.emit('update-downloaded', { version: '1.0.0' });
    updater.quitAndInstall.mockImplementation(() => {
      throw new Error('installer failed');
    });
    expect(updates.install()).toBe(false);
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'error', error: 'installer failed' }),
    );
  });
  it('publishes an error when the downloaded state is lost before installation', () => {
    const updates = new UpdateController(new FakeUpdater());
    expect(updates.install()).toBe(false);
    expect(updates.getSnapshot().status).toBe('error');
    expect(updates.getSnapshot().error).toContain('no longer ready');
  });
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
    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true);
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

    expect(updates.install()).toBe(false);
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

  it('installs a downloaded update silently and forces the app to relaunch', () => {
    const updater = new FakeUpdater();
    const updates = new UpdateController(updater);
    updater.emit('update-downloaded', { version: '0.9.1' });

    expect(updates.install()).toBe(true);
    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true);
  });
});
