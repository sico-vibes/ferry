// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { createMockFerryClient } from '@ferry/client';
import { afterEach, expect, it, vi } from 'vitest';
import { FerryProvider } from '../data/client';
import { ConversationUsageDialog } from './ConversationUsageDialog';

afterEach(cleanup);
it('distinguishes unreported tokens from recorded zero and explains incomplete history', async () => {
  const client = createMockFerryClient({ behavior: 'test' });
  const session = (await client.sessions.list())[0];
  const model = (await client.models.list())[0];
  if (!session || !model) throw new Error('Missing fixtures');
  const usage = vi.spyOn(client.sessions, 'modelUsage').mockResolvedValue({
    sessionId: session.id,
    totals: {
      requests: 1,
      inputTokens: 0,
      outputTokens: null,
      cachedTokens: null,
      reasoningTokens: null,
    },
    models: [
      {
        modelRef: model.ref,
        providerId: model.providerId,
        connectionId: null,
        accountKey: null,
        requests: 1,
        inputTokens: 0,
        outputTokens: null,
        cachedTokens: null,
        reasoningTokens: null,
        lastUsedAt: '2026-10-13T10:00:00.000Z',
        unreportedRequests: 0,
      },
    ],
    incomplete: true,
    coverage: { since: '2026-10-13T10:00:00.000Z', missing: true },
  });
  render(
    <FerryProvider client={client}>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <ConversationUsageDialog
          session={session}
          projectName="Bloblex"
          models={new Map([[model.ref, model]])}
          providers={new Map()}
          onClose={() => undefined}
        />
      </QueryClientProvider>
    </FerryProvider>,
  );
  const dialog = await screen.findByRole('dialog', { name: 'Conversation usage' });
  expect(dialog.textContent).toContain('Bloblex');
  await screen.findByRole('table');
  expect(screen.getAllByText('Not reported').length).toBeGreaterThan(0);
  expect(screen.getAllByText('0').length).toBeGreaterThan(0);
  expect(screen.getByText(/Some earlier usage was not reported/i)).toBeTruthy();
  expect(usage).toHaveBeenCalledWith(session.id);
});
