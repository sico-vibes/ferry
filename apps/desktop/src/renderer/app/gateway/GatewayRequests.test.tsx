// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockFerryClient } from '@ferry/client';
import { afterEach, expect, it } from 'vitest';
import { FerryProvider } from '../../data/client';
import { GatewayRequests } from './GatewayRequests';
afterEach(cleanup);
it('does not display compatibility zeros when the upstream explicitly reported no usage', async () => {
  const client = createMockFerryClient({ behavior: 'test' });
  client.__gatewayRequest({
    id: 'unreported-usage',
    at: new Date().toISOString(),
    keyId: 'fixture-key',
    keyName: 'Unreported usage client',
    requestedModel: 'ferry/auto',
    modelRef: 'groq/fixture',
    providerId: 'groq',
    status: 'ok',
    inputTokens: 0,
    outputTokens: 0,
    reportedUsage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: null },
    usageReported: false,
    latencyMs: 100,
    error: null,
  });
  render(
    <FerryProvider client={client}>
      <QueryClientProvider client={new QueryClient()}>
        <GatewayRequests />
      </QueryClientProvider>
    </FerryProvider>,
  );
  const row = (await screen.findByRole('button', { name: 'Unreported usage client' })).closest(
    'tr',
  );
  if (!row) throw new Error('Request row missing');
  expect(within(row).getByText('Not reported / Not reported').isConnected).toBe(true);
});

it('opens request details with the keyboard and restores the request control on Escape', async () => {
  const client = createMockFerryClient({ behavior: 'test' }),
    cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.__gatewayRequest({
    id: 'focus-request',
    at: new Date().toISOString(),
    keyId: 'fixture-key',
    keyName: 'Keyboard client',
    requestedModel: 'ferry/auto',
    modelRef: 'groq/fixture',
    providerId: 'groq',
    status: 'ok',
    inputTokens: 10,
    outputTokens: 2,
    latencyMs: 100,
    error: null,
  });
  render(
    <FerryProvider client={client}>
      <QueryClientProvider client={cache}>
        <GatewayRequests />
      </QueryClientProvider>
    </FerryProvider>,
  );
  const trigger = await screen.findByRole('button', { name: 'Keyboard client' });
  trigger.focus();
  const user = userEvent.setup({ delay: null });
  await user.keyboard('{Enter}');
  await screen.findByRole('heading', { name: 'Request details' });
  await user.keyboard('{Escape}');
  await waitFor(() => {
    expect(document.activeElement).toBe(trigger);
  });
});

it('shows partial usage without turning missing dimensions into zero', async () => {
  const client = createMockFerryClient({ behavior: 'test' });
  client.__gatewayRequest({
    id: 'partial-usage',
    at: new Date().toISOString(),
    keyId: 'fixture-key',
    keyName: 'Partial usage client',
    requestedModel: 'ferry/auto',
    servedModel: 'codex-cli/fixture',
    modelRef: 'codex-cli/fixture',
    providerId: 'codex-cli',
    servedConnectionId: 'codex-cli',
    status: 'ok',
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    reportedUsage: { inputTokens: 0, outputTokens: null, cachedTokens: null, reasoningTokens: 7 },
    usageReported: true,
    latencyMs: 100,
    error: null,
  });
  render(
    <FerryProvider client={client}>
      <QueryClientProvider client={new QueryClient()}>
        <GatewayRequests />
      </QueryClientProvider>
    </FerryProvider>,
  );
  const trigger = await screen.findByRole('button', { name: 'Partial usage client' });
  const row = trigger.closest('tr');
  if (!row) throw new Error('Request row missing');
  expect(within(row).getByText('0 / Not reported').isConnected).toBe(true);
  await userEvent.setup({ delay: null }).click(trigger);
  await screen.findByRole('heading', { name: 'Request details' });
  expect((await screen.findByText('0 / Not reported / Not reported')).isConnected).toBe(true);
  const reasoning = screen.getByText('Reasoning tokens').parentElement;
  if (!reasoning) throw new Error('Reasoning usage row missing');
  expect(within(reasoning).getByText('7').isConnected).toBe(true);
  expect(screen.getByText('Connection').nextElementSibling?.textContent).toBe('Codex CLI');
});
