import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMockFerryClient } from '@ferry/client';
import { PausedReasonSchema, ProviderIdSchema, ProviderFailuresSchema } from '@ferry/shared';
import { providers, runPrompt } from '../src/main.js';

afterEach(() => vi.restoreAllMocks());
function pausedClient() {
  const client = createMockFerryClient({ behavior: 'test' });
  const groq = client.__state().providers.find((provider) => provider.id === 'groq');
  if (!groq) throw new Error('Groq fixture missing');
  groq.enabled = false;
  groq.pausedReason = PausedReasonSchema.parse({
    kind: 'failed_requests',
    at: new Date().toISOString(),
    failedRequests: 5,
    lastError: '502 Upstream service error.',
    lastKind: 'server',
    models: ['groq/model'],
  });
  return client;
}
describe('CLI provider failures', () => {
  it('lists paused status and failure counts in text and JSON', async () => {
    const client = pausedClient();
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(await providers(client, ['list'])).toBe(0);
    expect(output.mock.calls.flat().join('')).toContain('paused');
    expect(output.mock.calls.flat().join('')).toContain('3 failed today');
    output.mockClear();
    await providers(client, ['list'], true);
    const listed = JSON.parse(output.mock.calls.flat().join('')) as {
      id: string;
      status: string;
      failures: { failed24h: number };
    }[];
    expect(listed.find((provider) => provider.id === 'groq')).toMatchObject({
      status: 'paused',
      failures: { failed24h: 3 },
    });
  });
  it('prints failures and resumes through the typed client', async () => {
    const client = pausedClient();
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await providers(client, ['failures', 'groq']);
    expect(output.mock.calls.flat().join('')).toContain('502');
    expect(output.mock.calls.flat().join('')).toContain('groq/openai/gpt-oss-120b');
    output.mockClear();
    await providers(client, ['failures', 'groq'], true);
    const failures = ProviderFailuresSchema.parse(JSON.parse(output.mock.calls.flat().join('')));
    expect(failures.providers[0]).toMatchObject({ providerId: 'groq', consecutive: 3 });
    expect(failures.recent[0]?.providerId).toBe('groq');
    const resume = vi.spyOn(client.providers, 'resume');
    await providers(client, ['resume', 'groq']);
    expect(resume).toHaveBeenCalledWith(ProviderIdSchema.parse('groq'));
    expect(
      (await client.providers.failures(ProviderIdSchema.parse('groq'))).providers[0],
    ).toMatchObject({ consecutive: 0, paused: null, failed24h: 3 });
  });
  it('prints a single warning when a run pauses a provider', async () => {
    const client = createMockFerryClient({
      behavior: 'test',
      scenarioRunner: {
        run({ store, emit }) {
          const groq = store.providers.find((provider) => provider.id === 'groq');
          if (!groq) throw new Error('Fixture missing');
          groq.pausedReason = PausedReasonSchema.parse({
            kind: 'failed_requests',
            at: new Date().toISOString(),
            failedRequests: 5,
            lastError: '502 Upstream service error.',
            lastKind: 'server',
            models: ['groq/model'],
          });
          groq.enabled = false;
          emit('provider.updated', groq);
          emit('provider.updated', groq);
          return Promise.resolve();
        },
      },
    });
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runPrompt(client, 'Test task', false, undefined, process.cwd(), { mock: true });
    expect(
      output.mock.calls
        .flat()
        .join('')
        .match(/Warning: Groq paused after 5 failed requests/g),
    ).toHaveLength(1);
  });
});
