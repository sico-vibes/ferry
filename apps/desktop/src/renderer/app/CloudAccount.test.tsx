// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockFerryClient, type CloudStatus } from '@ferry/client';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FerryProvider } from '../data/client';
import { RestartNotice } from './CloudAccount';
import { StorageChoice } from './OnboardingStorageChoice';

const baseStatus: CloudStatus = {
  storageMode: 'local',
  runningMode: 'local',
  pendingMode: null,
  configured: true,
  ownerEmail: null,
  message: null,
  auth: { signedIn: false, email: null, userId: null, isOwner: false },
  sync: { pending: 0, failed: 0, lastError: null, lastFlush: null },
};

function mount(node: ReactNode, client = createMockFerryClient({ behavior: 'test' })) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <FerryProvider client={client}>
      <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>
    </FerryProvider>,
  );
  return client;
}

afterEach(() => {
  cleanup();
  delete (window as { ferryHost?: unknown }).ferryHost;
});

describe('RestartNotice', () => {
  it('offers Restart now only when the saved storage mode needs a restart', () => {
    const relaunch = vi.fn().mockResolvedValue(undefined);
    window.ferryHost = { relaunch } as never;
    mount(<RestartNotice status={{ ...baseStatus, storageMode: 'cloud', pendingMode: 'cloud' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Restart now' }));
    expect(relaunch).toHaveBeenCalledOnce();
  });

  it('renders nothing without a pending mode', () => {
    mount(<RestartNotice status={baseStatus} />);
    expect(screen.queryByRole('button', { name: 'Restart now' })).toBeNull();
  });
});

describe('Onboarding storage choice', () => {
  it('offers Ferry Cloud only when cloud is configured on this device', async () => {
    const client = createMockFerryClient({ behavior: 'test' });
    vi.spyOn(client.cloud, 'status').mockResolvedValue({ ...baseStatus, configured: false });
    mount(<StorageChoice onContinue={vi.fn()} />, client);
    await screen.findByRole('button', { name: 'Continue on this device' });
    expect(screen.queryByRole('button', { name: 'Sign in to Ferry Cloud' })).toBeNull();
  });

  it('continues locally and records the choice', async () => {
    const client = createMockFerryClient({ behavior: 'test' });
    vi.spyOn(client.cloud, 'status').mockResolvedValue(baseStatus);
    const update = vi.spyOn(client.settings, 'update');
    const onContinue = vi.fn();
    mount(<StorageChoice onContinue={onContinue} />, client);
    fireEvent.click(await screen.findByRole('button', { name: 'Continue on this device' }));
    await vi.waitFor(() => {
      expect(onContinue).toHaveBeenCalled();
    });
    expect(update).toHaveBeenCalledWith({ cloudOnboardingChoice: 'local' });
  });

  it('shows the sign-in form once cloud is running after the restart', async () => {
    const client = createMockFerryClient({ behavior: 'test' });
    await client.settings.update({ cloudOnboardingChoice: 'cloud' });
    vi.spyOn(client.cloud, 'status').mockResolvedValue({
      ...baseStatus,
      storageMode: 'cloud',
      runningMode: 'cloud',
    });
    mount(<StorageChoice onContinue={vi.fn()} />, client);
    expect(await screen.findByLabelText('Password')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
  });
});
