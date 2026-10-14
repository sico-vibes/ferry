// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMockFerryClient } from '@ferry/client';
import { afterEach, expect, it, vi } from 'vitest';
import { FerryProvider } from '../data/client';
import { InstalledCliConnections } from './InstalledCliConnections';

afterEach(cleanup);
function mount(client: ReturnType<typeof createMockFerryClient>) {
  return render(
    <FerryProvider client={client}>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <InstalledCliConnections />
      </QueryClientProvider>
    </FerryProvider>,
  );
}

it('requires separate native and Gateway opt-ins without treating activation as verification', async () => {
  const client = createMockFerryClient({ behavior: 'test' });
  const update = vi.spyOn(client.cliConnections, 'update');
  mount(client);
  const native = await screen.findByRole('switch', { name: 'Use Codex CLI in Ferry' });
  const gateway = screen.getByRole('switch', { name: 'Allow Codex CLI in Gateway' });
  expect(native.getAttribute('aria-checked')).toBe('false');
  expect(gateway.getAttribute('aria-checked')).toBe('false');
  fireEvent.click(native);
  await waitFor(() => {
    expect(update).toHaveBeenCalledWith('codex-cli', {
      surfaces: { native: true, gateway: false },
    });
  });
  await waitFor(() => {
    expect(native.getAttribute('aria-checked')).toBe('true');
  });
  expect(gateway.getAttribute('aria-checked')).toBe('false');
  expect(
    (await client.cliConnections.list()).find((row) => row.id === 'codex-cli')?.verify.state,
  ).not.toBe('verified');
});

it('shows the actual verification failure and keeps surface permissions unchanged', async () => {
  const client = createMockFerryClient({ behavior: 'test' });
  const verify = vi.spyOn(client.cliConnections, 'verify').mockResolvedValue({
    ok: false,
    modelRef: null,
    message: 'Account capacity exhausted. Refresh after its reset.',
  });
  mount(client);
  await screen.findByRole('switch', { name: 'Use Codex CLI in Ferry' });
  const verifyButton = screen.getAllByRole('button', { name: 'Verify connection' })[0];
  if (!verifyButton) throw new Error('Missing verification action');
  fireEvent.click(verifyButton);
  expect((await screen.findByRole('alert')).textContent).toContain(
    'Account capacity exhausted. Refresh after its reset.',
  );
  expect(verify).toHaveBeenCalledTimes(1);
  expect(
    screen.getByRole('switch', { name: 'Allow Codex CLI in Gateway' }).getAttribute('aria-checked'),
  ).toBe('false');
});

it('provides native sign-in instructions without pretending it signed the user in', async () => {
  const client = createMockFerryClient({ behavior: 'test' });
  mount(client);
  await screen.findByRole('switch', { name: 'Use Codex CLI in Ferry' });
  const signInButton = screen.getAllByRole('button', { name: 'Sign-in instructions' })[0];
  if (!signInButton) throw new Error('Missing sign-in action');
  fireEvent.click(signInButton);
  expect(
    (await screen.findByRole('dialog', { name: 'Sign in to Codex CLI' })).textContent,
  ).toContain('codex login');
  expect(screen.getByText(/credentials stay in the client/i)).toBeTruthy();
});

it('indicates that generation verification is in progress until the client replies', async () => {
  const client = createMockFerryClient({ behavior: 'test' });
  let finish:
    ((value: Awaited<ReturnType<typeof client.cliConnections.verify>>) => void) | undefined;
  vi.spyOn(client.cliConnections, 'verify').mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  mount(client);
  await screen.findByRole('switch', { name: 'Use Codex CLI in Ferry' });
  const button = screen.getAllByRole('button', { name: 'Verify connection' })[0];
  if (!button) throw new Error('Missing verification action');
  fireEvent.click(button);
  expect(
    await screen.findByText('Waiting for Codex CLI to answer one small verification request…'),
  ).toBeTruthy();
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Waiting for reply…' }).disabled,
  ).toBe(true);
  if (!finish) throw new Error('Verification did not start');
  finish({ ok: true, modelRef: null, message: 'Verified.' });
  await waitFor(() => {
    expect(screen.queryByRole('button', { name: 'Waiting for reply…' })).toBeNull();
  });
});
