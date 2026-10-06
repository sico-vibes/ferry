// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockFerryClient } from '@ferry/client';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FerryProvider } from '../data/client';
import { CloudSettings } from './CloudSettings';

function mount(client = createMockFerryClient({ behavior: 'test' })) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <FerryProvider client={client}>
      <QueryClientProvider client={queryClient}>
        <CloudSettings />
      </QueryClientProvider>
    </FerryProvider>,
  );
  return client;
}
afterEach(cleanup);

describe('CloudSettings', () => {
  it('submits email and password, then clears the password field', async () => {
    const client = createMockFerryClient({ behavior: 'test' });
    vi.spyOn(client.cloud, 'status').mockResolvedValue({
      storageMode: 'cloud',
      configured: true,
      ownerEmail: null,
      message: 'Cloud sign-in required',
      auth: { signedIn: false, email: null, userId: null, isOwner: false },
      sync: { pending: 0, failed: 0, lastError: null, lastFlush: null },
    });
    mount(client);
    const signIn = vi
      .spyOn(client.cloud, 'signIn')
      .mockRejectedValue(new Error('Email or password is incorrect.'));
    fireEvent.change(await screen.findByLabelText('Email'), {
      target: { value: 'admin@example.com' },
    });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'never-print-this' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => {
      expect(signIn).toHaveBeenCalledWith({
        email: 'admin@example.com',
        password: 'never-print-this',
      });
    });
    const passwordInput = screen.getByLabelText('Password');
    if (!(passwordInput instanceof HTMLInputElement)) throw new Error('Expected password input');
    expect(passwordInput.value).toBe('');
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Email or password is incorrect.',
    );
  });
  it('calls the storage mode operation', async () => {
    const client = mount();
    const setMode = vi.spyOn(client.cloud, 'setStorageMode');
    fireEvent.click(await screen.findByRole('radio', { name: 'Cloud' }));
    await waitFor(() => {
      expect(setMode).toHaveBeenCalledWith({ mode: 'cloud' });
    });
  });
  it('calls sign out for a signed-in account', async () => {
    const client = createMockFerryClient({ behavior: 'test' });
    vi.spyOn(client.cloud, 'status').mockResolvedValue({
      storageMode: 'cloud',
      configured: true,
      ownerEmail: null,
      message: null,
      auth: { signedIn: true, email: 'admin@example.com', userId: 'u1', isOwner: true },
      sync: { pending: 0, failed: 0, lastError: null, lastFlush: null },
    });
    mount(client);
    const signOut = vi.spyOn(client.cloud, 'signOut');
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    await waitFor(() => {
      expect(signOut).toHaveBeenCalled();
    });
  });
});
