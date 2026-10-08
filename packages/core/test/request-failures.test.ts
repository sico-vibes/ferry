import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRpcFerryClient, type RpcFerryClient } from '@ferry/client';
import { MemorySecretStore } from '@ferry/secrets';
import { ProviderIdSchema, ProviderFailuresSchema, type Provider } from '@ferry/shared';
import { BUILTIN_PROFILES } from '@ferry/router';
import {
  CoreHost,
  createMemoryTransportPair,
  createServices,
  type FerryServices,
} from '../src/index.js';
import { register } from '../src/domains/providers.js';
import { register as registerSettings } from '../src/domains/settings.js';
import { createSessionDependencies } from '../src/session-deps.js';
import { ledgerKind, recordRequestFailure, recordRequestSuccess } from '../src/request-failures.js';

vi.setConfig({ testTimeout: 30_000 });
let dir: string;
let services: FerryServices;
let host: CoreHost;
let rpc: RpcFerryClient;
const groq = ProviderIdSchema.parse('groq');
const now = new Date('2026-10-08T10:00:00.000Z');
const events: { event: string; payload: unknown }[] = [];
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ferry-failure-ledger-'));
  services = await createServices({
    dataDir: dir,
    env: { NODE_ENV: 'test' },
    secrets: new MemorySecretStore(),
    clock: { now: () => now },
  });
  const [core, client] = createMemoryTransportPair();
  host = new CoreHost({ dataDir: dir, transport: core, services, localControl: false });
  register(host, services);
  registerSettings(host, services);
  const original = host.emit.bind(host);
  vi.spyOn(host, 'emit').mockImplementation((event, payload) => {
    events.push({ event, payload });
    original(event, payload);
  });
  await host.start();
  rpc = createRpcFerryClient(client);
  await rpc.hello;
});
afterAll(async () => {
  rpc.close();
  await host.stop();
  if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});
function fail(requestId: string, kind: 'server' | 'rate_limit' = 'server') {
  recordRequestFailure(services, {
    providerId: 'groq',
    modelRef: 'groq/model',
    keyId: null,
    requestId,
    sessionId: null,
    source: 'agent',
    kind,
    statusCode: kind === 'server' ? 502 : 429,
    message: 'Upstream service error',
  });
}

describe('provider auto-pause RPC', () => {
  it('pauses on five different requests, emits one toast, excludes routing, resumes and preserves history', async () => {
    await rpc.providers.setEnabled(groq, true);
    // A key reference supplies routing availability without any HTTP call.
    services.providerKeys.put({
      id: 'groq',
      providerId: 'groq',
      keyringRef: 'groq',
      createdAt: now.toISOString(),
    });
    const model = services.catalog.models.find(
      (entry) => entry.providerId === 'groq' && entry.toolCalling && entry.free,
    );
    if (!model) throw new Error('Groq model fixture missing');
    services.models.put('groq', { ...model, verified: true }, now.toISOString());
    const configured = services.providers.get('groq');
    if (!configured) throw new Error('Provider fixture missing');
    services.providers.put({
      ...configured,
      keyStatus: 'valid',
      modelCount: 1,
      availableModels: [model],
      modelsVerifiedAt: now.toISOString(),
    });
    const runtime = createSessionDependencies(services, () => undefined);
    const profile = BUILTIN_PROFILES[0];
    if (!profile) throw new Error('Profile fixture missing');
    // Provider snapshots are read live by routing.
    expect(runtime.providers().find((provider) => provider.id === 'groq')?.enabled).toBe(true);
    expect(
      runtime.gateway
        .resolveCandidates(profile, 'edit')
        .some((candidate) => candidate.providerId === 'groq'),
    ).toBe(true);
    for (let index = 0; index < 3; index++) fail('retry');
    fail('limit', 'rate_limit');
    for (let index = 1; index < 5; index++) fail(`request-${String(index)}`);
    const result = ProviderFailuresSchema.parse(await rpc.providers.failures(groq));
    expect(result.providers[0]).toMatchObject({
      consecutive: 5,
      counted24h: 5,
      failed24h: 6,
      paused: { failedRequests: 5 },
    });
    expect(runtime.providers().find((provider) => provider.id === 'groq')?.enabled).toBe(false);
    expect(
      runtime.gateway
        .resolveCandidates(profile, 'edit')
        .some((candidate) => candidate.providerId === 'groq'),
    ).toBe(false);
    expect(
      events.filter(
        (event) =>
          event.event === 'toast' &&
          (event.payload as { title?: string }).title?.includes('paused after'),
      ),
    ).toHaveLength(1);
    expect(
      events.some(
        (event) => event.event === 'provider.updated' && (event.payload as Provider).pausedReason,
      ),
    ).toBe(true);
    expect((await rpc.providers.resume(groq)).pausedReason).toBeNull();
    expect((await rpc.providers.failures(groq)).providers[0]).toMatchObject({
      consecutive: 0,
      failed24h: 6,
    });
    await rpc.providers.clearFailures(groq);
    expect((await rpc.providers.failures(groq)).recent).toEqual([]);
  });

  it('a success after four failures resets the counter; zero disables pausing and setting survives RPC', async () => {
    await rpc.providers.setEnabled(groq, true);
    for (let index = 0; index < 4; index++) fail(`before-${String(index)}`);
    recordRequestSuccess(services, 'groq', 'groq/model');
    fail('after');
    expect((await rpc.providers.failures(groq)).providers[0]).toMatchObject({
      consecutive: 1,
      paused: null,
      lastSuccessAt: now.toISOString(),
    });
    const settings = await rpc.settings.get();
    const updated = await rpc.settings.update({
      routing: { ...settings.routing, autoPauseAfterFailedRequests: 0 },
    });
    expect(updated.routing.autoPauseAfterFailedRequests).toBe(0);
    for (let index = 0; index < 6; index++) fail(`off-${String(index)}`);
    expect((await rpc.providers.list()).find((provider) => provider.id === 'groq')?.enabled).toBe(
      true,
    );
  });

  it('maps routing families to ledger kinds without counting capacity or local refusals', () => {
    expect(ledgerKind('quota_exhausted', 403, 'forbidden')).toBe('auth');
    expect(ledgerKind('quota_exhausted', 403, 'quota exhausted')).toBe('quota_exhausted');
    expect(ledgerKind('request_too_large', 413, 'too large')).toBe('context_too_large');
    expect(ledgerKind('stream_failure', null, 'No response')).toBe('no_response');
    expect(ledgerKind('stream_failure', null, 'fetch failed')).toBe('network');
    expect(ledgerKind('local_reservation', null, 'local')).toBe('local_reservation');
  });
});
