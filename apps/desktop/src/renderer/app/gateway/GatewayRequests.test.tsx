// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockFerryClient } from '@ferry/client';
import { afterEach, expect, it } from 'vitest';
import { FerryProvider } from '../../data/client';
import { GatewayRequests } from './GatewayRequests';
afterEach(cleanup);
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
