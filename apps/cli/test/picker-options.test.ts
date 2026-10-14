import { expect, it, vi } from 'vitest';
import { createMockFerryClient } from '@ferry/client';
import { ModelInfoSchema, ProviderSchema } from '@ferry/shared';
import { modelOptions } from '../src/picker-options.js';

it('lists each CLI model once when the provider registry also contains its connection', async () => {
  const client = createMockFerryClient({ behavior: 'test' });
  const [models, providers, connections] = await Promise.all([
    client.models.list(),
    client.providers.list(),
    client.cliConnections.list(),
  ]);
  const base = models[0];
  const provider = providers[0];
  const connection = connections.find((row) => row.kind === 'codex-cli');
  const capability = connection?.models[0];
  if (!base || !provider || !connection || !capability) throw new Error('Missing CLI fixture');
  vi.spyOn(client.models, 'list').mockResolvedValue([
    ...models,
    ModelInfoSchema.parse({
      ...base,
      ref: capability.ref,
      name: capability.name,
      providerId: connection.providerId,
      cliConnectionId: connection.id,
      cliCapabilities: capability,
      verified: true,
      free: false,
    }),
  ]);
  vi.spyOn(client.providers, 'list').mockResolvedValue([
    ...providers,
    ProviderSchema.parse({
      ...provider,
      id: connection.providerId,
      kind: 'cli',
      enabled: true,
      keyRequired: false,
      keyStatus: 'not_applicable',
    }),
  ]);
  vi.spyOn(client.cliConnections, 'list').mockResolvedValue([
    {
      ...connection,
      surfaces: { native: true, gateway: false },
      verify: {
        state: 'verified',
        modelRef: capability.ref,
        checkedAt: '2026-10-15T00:00:00.000Z',
        message: null,
      },
    },
  ]);
  const options = await modelOptions(client);
  const cliRows = options.filter((row) => row.label === capability.name);
  expect(cliRows).toHaveLength(1);
  expect(cliRows[0]?.group).toBe('Codex CLI');
});
