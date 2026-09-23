import { describe, expect, it } from 'vitest';
import { ProviderSchema } from '@ferry/shared';
import type { Provider } from '@ferry/shared';
import { createMockFerryClient } from '../src/mock/client.js';
import { createFakeClock } from '../src/mock/clock.js';

const now = new Date('2026-09-23T21:47:00.000Z');
const makeClient = () => createMockFerryClient({ clock: createFakeClock(now).clock });

const providerId = (client: ReturnType<typeof makeClient>, id: string): Provider['id'] => {
  const provider = client.__state().providers.find((item) => item.id === id);
  if (!provider) throw new Error(`Provider fixture missing: ${id}`);
  return provider.id;
};

describe('QA providers domain', () => {
  it('rejects an empty key and marks a bad key invalid', async () => {
    const client = makeClient();
    const gemini = providerId(client, 'gemini');
    await expect(client.providers.setKey(gemini, '')).rejects.toThrow('Key cannot be empty');
    const bad = await client.providers.setKey(gemini, 'bad-key');
    expect(bad.keyStatus).toBe('invalid');
  });

  it('probes missing and invalid providers with ok:false', async () => {
    const client = makeClient();
    const gemini = providerId(client, 'gemini');
    await client.providers.removeKey(gemini);
    const missing = await client.providers.probe(gemini);
    expect(missing.ok).toBe(false);
    expect(missing.latencyMs).toBeNull();

    await client.providers.setKey(gemini, 'bad-key');
    const invalid = await client.providers.probe(gemini);
    expect(invalid.ok).toBe(false);
  });

  it('probes a valid provider, marks it valid and emits provider.updated', async () => {
    const client = makeClient();
    const mistral = providerId(client, 'mistral');
    await client.providers.setKey(mistral, 'ok-key');

    const events: Provider[] = [];
    client.on('provider.updated', (provider) => events.push(provider));

    const result = await client.providers.probe(mistral);
    expect(result.ok).toBe(true);
    expect(result.latencyMs).not.toBeNull();
    expect((await client.providers.list()).find((item) => item.id === mistral)?.keyStatus).toBe(
      'valid',
    );
    expect(events).toHaveLength(1);
    const payload = events[0];
    if (!payload) throw new Error('provider.updated was not emitted');
    expect(payload.keyStatus).toBe('valid');
    expect(ProviderSchema.parse(payload).keyStatus).toBe('valid');
  });
});
