import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createCoreHost } from '../src/index.js';
import { OAuthProviderSchema } from '@ferry/shared';
import { MemorySecretStore } from '@ferry/secrets';

it('isolates failed sign-ins and always returns unavailable and coming-soon entries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ferry-oauth-list-'));
  const host = await createCoreHost({ dataDir: root });
  try {
    const services = host.options.services;
    if (!services) throw new Error('Missing services');
    const secrets = new MemorySecretStore();
    vi.spyOn(secrets, 'get').mockImplementation((id) =>
      id === 'oauth:anthropic'
        ? Promise.reject(new Error('Key store unavailable'))
        : Promise.resolve(undefined),
    );
    (services as { secrets: typeof services.secrets }).secrets = secrets;
    const providers = OAuthProviderSchema.array().parse(
      await host.dispatch({ jsonrpc: '2.0', id: 1, method: 'oauth.list' }),
    );
    expect(providers.find((item) => item.id === 'anthropic')).toMatchObject({
      status: 'unavailable',
      reason: 'Key store unavailable',
      actionAvailable: false,
    });
    expect(providers.find((item) => item.id === 'openai-codex')).toMatchObject({
      status: 'not_connected',
      actionAvailable: true,
    });
    expect(providers.find((item) => item.id === 'github-copilot')?.models.length).toBeGreaterThan(
      0,
    );
    expect(providers.map((item) => item.id)).toEqual(
      expect.arrayContaining(['kilo', 'qoder', 'cline', 'gemini-cli', 'antigravity']),
    );
    expect(providers.find((item) => item.id === 'gemini-cli')).toMatchObject({
      status: 'unavailable',
      actionAvailable: false,
    });
  } finally {
    await host.stop();
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}, 30_000);
