// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockFerryClient } from '@ferry/client';
import { FerryProvider } from '../data/client';
import { ProviderKeyDialog } from './ProviderKeyDialog';
afterEach(cleanup);
it('connects a local server without creating a dummy credential', async () => {
  const client = createMockFerryClient({ behavior: 'test' });
  const provider = (await client.providers.list()).find((row) => row.id === 'ollama');
  if (!provider) throw new Error('Missing local fixture');
  const setKey = vi.spyOn(client.providers, 'setKey');
  const setEnabled = vi.spyOn(client.providers, 'setEnabled');
  render(
    <FerryProvider client={client}>
      <QueryClientProvider client={new QueryClient()}>
        <ProviderKeyDialog provider={provider} open onOpenChange={() => undefined} />
      </QueryClientProvider>
    </FerryProvider>,
  );
  await userEvent.click(await screen.findByRole('button', { name: 'Connect without a key' }));
  await waitFor(() => {
    expect(setEnabled).toHaveBeenCalledWith(provider.id, true);
  });
  expect(setKey).not.toHaveBeenCalled();
  expect(await screen.findByText(/Connection enabled without a key/)).toBeTruthy();
});
