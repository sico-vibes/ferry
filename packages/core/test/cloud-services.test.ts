import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServices } from '../src/services.js';
import type { FerrySupabaseClient } from '@ferry/cloud';
import type { Session } from '@ferry/shared';

const dirs: string[] = [];
vi.setConfig({ testTimeout: 30_000 });
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tempHome(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'ferry-cloud-services-'));
  dirs.push(path);
  return path;
}
const fakeClient = {
  auth: {
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => undefined } } }),
    getUser: () => Promise.resolve({ data: { user: null }, error: null }),
    signOut: () => Promise.resolve({ error: null }),
    signInWithPassword: () => Promise.resolve({ error: null }),
  },
  schema: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }),
      }),
    }),
  }),
} as unknown as FerrySupabaseClient;
const env = {
  NODE_ENV: 'test',
  FERRY_SUPABASE_URL: 'https://example.supabase.co',
  FERRY_SUPABASE_PUBLISHABLE_KEY: 'test-key',
};

describe('createServices cloud mode selection', () => {
  it('keeps local mode free of Supabase clients and outbox writes', async () => {
    const dataDir = await tempHome();
    let clientFactoryCalls = 0;
    const services = await createServices({
      dataDir,
      env,
      cloudClientFactory: () => {
        clientFactoryCalls += 1;
        return fakeClient;
      },
    });
    try {
      services.settings.put('global', { storageMode: 'local' });
      expect(clientFactoryCalls).toBe(0);
      const count = services.db.client
        .prepare('SELECT count(*) AS count FROM cloud_outbox')
        .get() as { count: number };
      expect(count.count).toBe(0);
    } finally {
      await services.dispose();
    }
  });

  it('falls back to local and reports missing configuration in cloud mode', async () => {
    const dataDir = await tempHome();
    const seed = await createServices({ dataDir, env: { NODE_ENV: 'test' } });
    seed.settings.put('global', { storageMode: 'cloud' });
    await seed.dispose();
    const services = await createServices({
      dataDir,
      env: { NODE_ENV: 'test', FERRY_SUPABASE_URL: '', FERRY_SUPABASE_PUBLISHABLE_KEY: '' },
    });
    try {
      expect(await services.cloud.status()).toMatchObject({
        configured: false,
        message: 'Supabase cloud configuration is missing',
      });
      services.sessions.put({
        id: 'session_local' as Session['id'],
        workspaceId: 'workspace_1' as Session['workspaceId'],
        title: 'Local',
        preview: '',
        profileId: 'profile_1' as Session['profileId'],
        modelRef: null,
        pinnedModelRef: null,
        starred: false,
        pinned: false,
        status: 'idle',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        agentEvents: [],
      });
      const count = services.db.client
        .prepare('SELECT count(*) AS count FROM cloud_outbox')
        .get() as { count: number };
      expect(count.count).toBe(0);
    } finally {
      await services.dispose();
    }
  });

  it('mirrors session writes with the selection field contract when configured', async () => {
    const dataDir = await tempHome();
    const seed = await createServices({ dataDir, env: { NODE_ENV: 'test' } });
    seed.settings.put('global', { storageMode: 'cloud' });
    await seed.dispose();
    const services = await createServices({ dataDir, env, cloudClientFactory: () => fakeClient });
    try {
      services.sessions.put({
        id: 'session_cloud' as Session['id'],
        workspaceId: 'workspace_1' as Session['workspaceId'],
        title: 'Cloud',
        preview: '',
        profileId: 'profile_1' as Session['profileId'],
        modelRef: 'openai/gpt-4o' as NonNullable<Session['modelRef']>,
        pinnedModelRef: null,
        starred: false,
        pinned: false,
        status: 'idle',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        agentEvents: [],
      });
      const row = services.db.client
        .prepare("SELECT payload_json FROM cloud_outbox WHERE target='sessions'")
        .get() as { payload_json: string };
      expect(JSON.parse(row.payload_json)).toMatchObject({
        id: 'session_cloud',
        selected_model: 'auto',
        pinned_model: null,
      });
    } finally {
      await services.dispose();
    }
  });
});
