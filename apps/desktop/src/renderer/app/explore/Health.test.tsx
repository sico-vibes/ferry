// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import { createMockFerryClient } from '@ferry/client';
import type { ProviderHealthSnapshot } from '@ferry/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FerryProvider } from '../../data/client';
import { HealthTab } from './Health';

afterEach(() => {
  cleanup();
});

describe('HealthTab', () => {
  it('lists connected providers worst first with latency, pauses and locked models', async () => {
    const client = createMockFerryClient({ behavior: 'test' });
    const providers = (await client.providers.list()).filter(
      (provider) =>
        provider.enabled &&
        (provider.keyStatus === 'valid' || provider.keyStatus === 'not_applicable'),
    );
    const [first, second] = providers;
    if (!first || !second) throw new Error('Expected two connected mock providers');
    const snapshot = (
      providerId: string,
      patch: Partial<ProviderHealthSnapshot>,
    ): ProviderHealthSnapshot =>
      ({
        providerId,
        state: 'healthy',
        breaker: 'closed',
        openedAt: null,
        nextProbeAt: null,
        lastError: null,
        keys: [],
        lockedModels: [],
        latencyP50Ms: 420,
        latencyP95Ms: 900,
        successRate1h: 0.98,
        ...patch,
      }) as ProviderHealthSnapshot;
    vi.spyOn(client.providers, 'health').mockResolvedValue([
      snapshot(first.id, {}),
      snapshot(second.id, {
        state: 'down',
        breaker: 'open',
        nextProbeAt: new Date(Date.now() + 60_000).toISOString(),
        lastError: '503 Service Unavailable',
        lockedModels: [
          { ref: `${second.id}/gone-model`, until: new Date().toISOString(), reason: 'not found' },
        ] as ProviderHealthSnapshot['lockedModels'],
      }),
    ]);
    render(
      <FerryProvider client={client}>
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <HealthTab />
        </QueryClientProvider>
      </FerryProvider>,
    );
    const [down, healthy] = await screen.findAllByRole('listitem');
    if (!down || !healthy) throw new Error('Expected two provider rows');
    // The provider that is down comes first, with why and when Ferry retries.
    expect(within(down).getByText('Down')).toBeTruthy();
    expect(within(down).getByText(/Last error: 503/)).toBeTruthy();
    expect(within(down).getByText(/Paused · next check in/)).toBeTruthy();
    expect(within(down).getByText(/gone-model \(not found\)/)).toBeTruthy();
    expect(within(healthy).getByText(/420 ms typical · 900 ms slow/)).toBeTruthy();
    expect(within(healthy).getByText('Success 98% last hour')).toBeTruthy();
  });
});
