// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi, type MockInstance } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockFerryClient, type FerryClient } from '@ferry/client';
import { FerryProvider } from '../data/client';
import { ZenCliConnection } from './ZenCliConnection';
import { ZenSetupPrompt } from './ZenSetupPrompt';
import { ProviderIdSchema } from '@ferry/shared';
afterEach(cleanup);

async function verificationFeedback(
  verify: MockInstance<FerryClient['providers']['verifyZenCli']>,
) {
  await waitFor(() => {
    expect(verify.mock.settledResults[0]?.type).toBe('fulfilled');
  });
  const outcome = verify.mock.settledResults[0];
  if (outcome?.type !== 'fulfilled') throw new Error('Verification did not complete');
  expect(outcome.value.ok).toBe(true);
  await screen.findByText(outcome.value.message);
}
it('refreshes the shared CLI inventory when Detect again is selected', async () => {
  const client = createMockFerryClient({ behavior: 'test' });
  const refresh = vi.spyOn(client.cliConnections, 'refresh');
  render(
    <FerryProvider client={client}>
      <QueryClientProvider client={new QueryClient()}>
        <ZenCliConnection />
      </QueryClientProvider>
    </FerryProvider>,
  );
  await waitFor(() => {
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Detect again' }).disabled).toBe(
      false,
    );
  });
  await userEvent
    .setup({ delay: null })
    .click(await screen.findByRole('button', { name: 'Detect again' }));
  await waitFor(() => {
    expect(refresh).toHaveBeenCalledWith('opencode-cli');
  });
  await screen.findByText('Detection complete. Verify a free model to check access.');
});

it('offers a detected Go credential only after an explicit opt-in', async () => {
  const client = createMockFerryClient({ behavior: 'test' });
  const status = await client.providers.zenCliStatus();
  vi.spyOn(client.providers, 'zenCliStatus').mockResolvedValue({
    ...status,
    credentialSource: 'opencode_go',
    verifiedModels: [],
  });
  const verify = vi.spyOn(client.providers, 'verifyZenCli');
  render(
    <FerryProvider client={client}>
      <QueryClientProvider client={new QueryClient()}>
        <ZenCliConnection />
      </QueryClientProvider>
    </FerryProvider>,
  );
  await screen.findByText(/OpenCode Go credential found; Zen access not checked/);
  const offer = await screen.findByRole('switch', { name: 'Offer OpenCode Go credential to Zen' });
  expect(offer.getAttribute('aria-checked')).toBe('false');
  await userEvent.setup({ delay: null }).click(offer);
  await waitFor(async () => {
    expect((await client.settings.get()).cliConnections['opencode-cli']?.credentialProvider).toBe(
      'opencode-go',
    );
  });
  expect(verify).not.toHaveBeenCalled();
});

it('recognizes verified native Zen capacity independently of the standard API connection', async () => {
  const client = createMockFerryClient({ behavior: 'test' });
  const connection = (await client.cliConnections.list()).find(
    (item) => item.id === 'opencode-cli',
  );
  const model = connection?.models.find(
    (item) => item.upstreamProvider === 'opencode' && item.billing === 'free',
  );
  if (!model) throw new Error('Missing free Zen fixture');
  await client.cliConnections.update('opencode-cli', { surfaces: { native: true } });
  expect((await client.cliConnections.verify('opencode-cli', model.ref)).ok).toBe(true);
  await client.providers.setEnabled(ProviderIdSchema.parse('opencode'), false);
  const cache = new QueryClient();
  await Promise.all([
    cache.query({ queryKey: ['providers'], queryFn: () => client.providers.list() }),
    cache.query({
      queryKey: ['cli-connections'],
      queryFn: () => client.cliConnections.list(),
    }),
  ]);
  render(
    <FerryProvider client={client}>
      <QueryClientProvider client={cache}>
        <ZenSetupPrompt />
      </QueryClientProvider>
    </FerryProvider>,
  );
  await waitFor(() => {
    expect(screen.queryByRole('button', { name: 'Set up Zen' })).toBeNull();
  });
});

it('keeps the setup dialog open for success feedback when verification enables Zen', async () => {
  const client = createMockFerryClient({ behavior: 'test' });
  const verify = vi.spyOn(client.providers, 'verifyZenCli');
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
  await verificationFeedback(verify);
  expect(screen.getByRole('dialog', { name: 'Manage OpenCode Zen connection' })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Done' }));
  await waitFor(() => {
    expect(screen.queryByRole('button', { name: 'Set up Zen' })).toBeNull();
  });
});
it('requires independent surface opt-ins and explicitly verifies the discovered free model', async () => {
  const client = createMockFerryClient({ behavior: 'test' });
  const freeModel = (await client.providers.zenCliStatus()).freeModels[0];
  if (!freeModel) throw new Error('No discovered free Zen model');
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
  await waitFor(() => {
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Detect again' }).disabled).toBe(
      false,
    );
  });
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
  await verificationFeedback(verify);
  expect(verify).toHaveBeenCalledWith(freeModel.ref);
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
