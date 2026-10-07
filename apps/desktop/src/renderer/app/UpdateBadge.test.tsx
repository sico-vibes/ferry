// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UpdateSnapshot } from '../../main/update-state.js';
import { useUI } from '../state/ui';
import { UpdateBadge } from './UpdateBadge';

function mountWith(initial: UpdateSnapshot) {
  let push: (next: UpdateSnapshot) => void = () => undefined;
  const host = {
    getUpdateState: vi.fn().mockResolvedValue(initial),
    onUpdateState: vi.fn((handler: (next: UpdateSnapshot) => void) => {
      push = handler;
      return () => undefined;
    }),
    downloadUpdate: vi.fn().mockResolvedValue(initial),
    installUpdate: vi.fn().mockResolvedValue(undefined),
  };
  window.ferryHost = host as never;
  render(<UpdateBadge />);
  return {
    host,
    push: (next: UpdateSnapshot) => {
      act(() => {
        push(next);
      });
    },
  };
}

const base: UpdateSnapshot = { status: 'idle', version: null, error: null, autoDownload: false };

afterEach(() => {
  cleanup();
  delete (window as { ferryHost?: unknown }).ferryHost;
});

describe('UpdateBadge', () => {
  it('stays hidden when there is no update', async () => {
    mountWith(base);
    await act(() => Promise.resolve());
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('downloads, then installs on the next click', async () => {
    const { host, push } = mountWith({ ...base, status: 'available', version: '1.0.0' });
    fireEvent.click(await screen.findByRole('button', { name: 'Update available' }));
    expect(host.downloadUpdate).toHaveBeenCalledOnce();
    push({ ...base, status: 'downloaded', version: '1.0.0' });
    fireEvent.click(await screen.findByRole('button', { name: 'Restart to update' }));
    expect(host.installUpdate).toHaveBeenCalledOnce();
  });

  it('shows a failed install and opens About', async () => {
    mountWith({ ...base, status: 'error', version: '1.0.0', error: 'Installer blocked' });
    const badge = await screen.findByRole('button', { name: 'Update failed' });
    expect(badge.getAttribute('title')).toBe('Installer blocked');
    fireEvent.click(badge);
    expect(useUI.getState().settingsSection).toBe('About');
  });
});
