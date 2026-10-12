import { expect, it } from 'vitest';
import { ProviderIdSchema } from '@ferry/shared';
import { createMockFerryClient } from '../src/index.js';

it('includes each connected free fixture despite its unknown nominal price, while listing skipped connections', async () => {
  const client = createMockFerryClient({ behavior: 'test' });
  for (const raw of ['gemini', 'nvidia', 'mistral']) {
    const id = ProviderIdSchema.parse(raw);
    await client.providers.setKey(id, 'preview-fixture-key');
    await client.providers.setEnabled(id, true);
    await client.providers.probe(id);
  }
  const run = await client.providers.startChecks();
  const progress = await client.providers.checkProgress(run.id);
  for (const providerId of ['gemini', 'nvidia', 'mistral']) {
    expect(progress.results.find((result) => result.providerId === providerId)).toMatchObject({
      ok: true,
      paid: false,
    });
  }
  expect(
    progress.entries?.some((entry) => entry.state === 'skipped' && Boolean(entry.reason)),
  ).toBe(true);
});
