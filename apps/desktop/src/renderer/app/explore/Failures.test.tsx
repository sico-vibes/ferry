// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMockFerryClient } from '@ferry/client';
import { PausedReasonSchema, ProviderIdSchema } from '@ferry/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FerryProvider } from '../../data/client';
import { HealthTab } from './Health';
import { ProviderStatusBadge } from '../ProviderStatusBadge';
import { V2Sidebar } from '../V2Sidebar';
import { providerStatus } from '../ProvidersTable';

afterEach(() => {
  cleanup();
});
function fixture() {
  const client = createMockFerryClient({ behavior: 'test' });
  const groq = client.__state().providers.find((provider) => provider.id === 'groq');
  if (!groq) throw new Error('Fixture missing');
  groq.enabled = false;
  groq.pausedReason = PausedReasonSchema.parse({
    kind: 'failed_requests',
    at: new Date().toISOString(),
    failedRequests: 5,
    lastError: '502 Upstream service error.',
    lastKind: 'server',
    models: ['groq/model'],
  });
  return { client, groq };
}
function mount(ui: React.ReactNode, client: ReturnType<typeof createMockFerryClient>) {
  return render(
    <FerryProvider client={client}>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        {ui}
      </QueryClientProvider>
    </FerryProvider>,
  );
}
describe('provider failure visibility', () => {
  it('uses the danger Paused badge ahead of the disabled status', () => {
    const { client, groq } = fixture();
    mount(<ProviderStatusBadge status="disabled" paused />, client);
    expect(screen.getByText('Paused').className).toContain('destructive');
    expect(providerStatus(groq)).toEqual({ label: 'Paused', tone: 'destructive' });
  });
  it('renders the ledger, expands models, and wires Check key, View failures and Resume', async () => {
    const { client } = fixture();
    const resume = vi.spyOn(client.providers, 'resume');
    const probe = vi.spyOn(client.providers, 'probe');
    const scroll = vi.fn();
    const original = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
    Element.prototype.scrollIntoView = scroll;
    try {
      mount(<HealthTab />, client);
      expect(await screen.findByText('Groq was paused after 5 failed requests.')).toBeTruthy();
      expect(await screen.findByText('Recent failures')).toBeTruthy();
      expect(screen.getByText('3 in 24 h / 3 in 7 d')).toBeTruthy();
      await userEvent.click(screen.getByRole('button', { name: 'View failures' }));
      expect(document.querySelector('#provider-failures details')?.hasAttribute('open')).toBe(true);
      expect(scroll).toHaveBeenCalled();
      expect(screen.getByText('Failing')).toBeTruthy();
      await userEvent.click(screen.getByRole('button', { name: 'Check key' }));
      await waitFor(() => {
        expect(probe).toHaveBeenCalledWith(ProviderIdSchema.parse('groq'));
      });
      await waitFor(() => {
        expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Resume' }).disabled).toBe(
          false,
        );
      });
      await userEvent.click(screen.getByRole('button', { name: 'Resume' }));
      await waitFor(() => {
        expect(resume).toHaveBeenCalledWith(ProviderIdSchema.parse('groq'));
      });
      await waitFor(() => {
        expect(screen.queryByRole('region', { name: 'Paused providers' })).toBeNull();
      });
    } finally {
      if (original) Object.defineProperty(Element.prototype, 'scrollIntoView', original);
      else Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
    }
  });
  it('shows a sidebar dot and count while a provider is auto-paused', async () => {
    const { client } = fixture();
    const root = createRootRoute({ component: () => <V2Sidebar onNewChat={() => undefined} /> });
    const router = createRouter({
      routeTree: root,
      history: createMemoryHistory({ initialEntries: ['/'] }),
    });
    await router.load();
    mount(<RouterProvider router={router} />, client);
    expect(await screen.findByRole('status', { name: '1 paused providers' })).toBeTruthy();
  });
});
