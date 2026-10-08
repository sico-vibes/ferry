import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MemorySecretStore } from '@ferry/secrets';
import { ModelRefSchema, ProviderIdSchema, SessionSchema } from '@ferry/shared';
import { BUILTIN_PROFILES } from '@ferry/router';
import { createCoreHost } from '../src/index.js';

const requests = vi.hoisted(() => [] as { messages: string; tools: number; system: string }[]);
vi.mock('../src/session-deps.js', async (original) => {
  const actual = await original<typeof import('../src/session-deps.js')>();
  return {
    ...actual,
    createSessionDependencies: (...args: Parameters<typeof actual.createSessionDependencies>) => {
      const runtime = actual.createSessionDependencies(...args);
      runtime.gateway.streamStep = (request) => {
        requests.push({
          messages: JSON.stringify(request.messages),
          tools: request.tools.length,
          system: request.system,
        });
        return Promise.resolve({
          text:
            requests.length === 2
              ? 'Preserve the coding constraints and resume the pending fix.'
              : 'done',
          toolCalls: [],
          inputTokens: 20,
          outputTokens: 5,
        });
      };
      return runtime;
    },
  };
});

describe('sessions.compact RPC', () => {
  it(
    'summarizes through the model pipeline, keeps history, and uses the summary on later turns',
    { timeout: 30_000 },
    async () => {
      const temporary = fileURLToPath(new URL('../../../.dev/test-tmp/', import.meta.url));
      await mkdir(temporary, { recursive: true });
      const root = await mkdtemp(join(temporary, 'compact-'));
      const network = vi
        .spyOn(globalThis, 'fetch')
        .mockRejectedValue(new Error('Network forbidden'));
      const host = await createCoreHost({
        dataDir: join(root, 'data'),
        env: { ...process.env, NODE_ENV: 'production' },
      });
      requests.length = 0;
      try {
        const services = host.options.services;
        if (!services) throw new Error('Missing services');
        const secrets = new MemorySecretStore();
        await secrets.set('openrouter', 'fixture');
        (services as { secrets: typeof services.secrets }).secrets = secrets;
        const providerId = ProviderIdSchema.parse('openrouter');
        services.providerKeys.put({
          id: providerId,
          providerId,
          keyringRef: providerId,
          createdAt: new Date().toISOString(),
        });
        const model = services.catalog.models.find(
          (row) =>
            row.providerId === providerId &&
            row.free &&
            row.toolCalling &&
            row.ref.endsWith(':free'),
        );
        const profile = BUILTIN_PROFILES.find((row) => row.name === 'Auto-Free');
        if (!model || !profile) throw new Error('Missing fixtures');
        services.models.put(providerId, model);
        services.settings.put('profile-overrides', [
          { ...profile, roles: { ...profile.roles, enabled: false } },
        ]);
        const rpc = (method: string, params: unknown[] = []) =>
          host.dispatch({ jsonrpc: '2.0', id: 'test', method, params });
        const session = SessionSchema.parse(
          await rpc('sessions.create', [{ workspaceId: null, profileId: profile.id }]),
        );
        await rpc('models.select', [session.id, ModelRefSchema.parse(model.ref)]);
        const settle = async () => {
          await vi.waitFor(
            () => {
              expect(services.sessions.get(session.id)?.inFlight).toBe(false);
            },
            { timeout: 15_000, interval: 10 },
          );
        };
        await rpc('sessions.send', [
          session.id,
          { text: 'ORIGINAL_CONTEXT_MARKER: fix the code without changing constraints' },
        ]);
        await settle();
        await rpc('sessions.compact', [session.id]);
        await settle();
        expect(requests[1]?.tools).toBe(0);
        expect(requests[1]?.system).toContain('Summarize');
        expect(requests[1]?.messages).toContain('ORIGINAL_CONTEXT_MARKER');
        expect(services.settings.get(`context-summary:${session.id}`)).toMatchObject({
          summary: 'Preserve the coding constraints and resume the pending fix.',
        });
        await rpc('sessions.send', [session.id, { text: 'continue' }]);
        await settle();
        expect(requests[2]?.messages).toContain('Preserve the coding constraints');
        expect(requests[2]?.messages).not.toContain('ORIGINAL_CONTEXT_MARKER');
        const detail = await rpc('sessions.get', [session.id]);
        expect(JSON.stringify(detail)).toContain('ORIGINAL_CONTEXT_MARKER');
        const settings = await rpc('settings.update', [{ notifications: false }]);
        expect(settings).toMatchObject({ notifications: false });
      } finally {
        await host.stop();
        network.mockRestore();
        await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      }
    },
  );
});
