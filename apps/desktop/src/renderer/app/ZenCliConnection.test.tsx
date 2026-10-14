// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockFerryClient } from '@ferry/client';
import { FerryProvider } from '../data/client';
import { ZenCliConnection } from './ZenCliConnection';
import { ZenSetupPrompt } from './ZenSetupPrompt';
afterEach(cleanup);
it('keeps the setup dialog open for success feedback when verification enables Zen', async () => {
  const client = createMockFerryClient({ behavior: 'test' });
  render(
    <FerryProvider client={client}>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <ZenSetupPrompt />
      </QueryClientProvider>
    </FerryProvider>,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Set up Zen' }));
  await user.click(await screen.findByRole('switch', { name: 'Use installed OpenCode CLI' }));
  await user.click(await screen.findByRole('button', { name: 'Verify free CLI access' }));
  await screen.findByText('Preview: free generation verified through OpenCode CLI.');
  expect(screen.getByRole('dialog', { name: 'Manage OpenCode Zen connection' })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Done' }));
  await waitFor(() => {
    expect(screen.queryByRole('button', { name: 'Set up Zen' })).toBeNull();
  });
});
it('detects Zen credentials and requires independent surface opt-ins and an explicit check', async () => {
  const client = createMockFerryClient({ behavior: 'test' });
  const verify = vi.spyOn(client.providers, 'verifyZenCli');
  const addKey = vi.spyOn(client.providers, 'addKey');
  render(
    <FerryProvider client={client}>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <ZenCliConnection />
      </QueryClientProvider>
    </FerryProvider>,
  );
  await screen.findByText(/OpenCode Zen credential found/);
  const user = userEvent.setup();
  await user.click(screen.getByRole('switch', { name: 'Use installed OpenCode CLI' }));
  await waitFor(async () => {
    expect((await client.settings.get()).opencodeZenTransport).toBe('cli');
    expect((await client.settings.get()).cliConnections['opencode-cli']?.native).toBe(true);
    expect((await client.settings.get()).cliConnections['opencode-cli']?.gateway).toBe(false);
  });
  expect(verify).not.toHaveBeenCalled();
  expect(screen.getByText(/Ferry chat and the Gateway API/)).toBeTruthy();
  await user.click(await screen.findByRole('button', { name: 'Verify free CLI access' }));
  await screen.findByText('Preview: free generation verified through OpenCode CLI.');
  expect(verify).toHaveBeenCalledWith('opencode/big-pickle');
  expect(addKey).not.toHaveBeenCalled();
  await user.click(screen.getByRole('switch', { name: 'Allow Zen CLI in Gateway' }));
  await waitFor(async () => {
    expect((await client.settings.get()).cliConnections['opencode-cli']?.gateway).toBe(true);
  });
  await user.click(screen.getByRole('switch', { name: 'Use installed OpenCode CLI' }));
  await waitFor(async () => {
    expect((await client.settings.get()).cliConnections['opencode-cli']?.native).toBe(false);
    expect((await client.settings.get()).cliConnections['opencode-cli']?.gateway).toBe(true);
    expect((await client.settings.get()).opencodeZenTransport).toBe('cli');
  });
  await user.click(screen.getByRole('switch', { name: 'Allow Zen CLI in Gateway' }));
  await waitFor(async () => {
    expect((await client.settings.get()).opencodeZenTransport).toBe('api');
  });
});
