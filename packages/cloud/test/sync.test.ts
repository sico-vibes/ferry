import { describe, expect, it, vi } from 'vitest';
import { openDatabase, OutboxRepository } from '@ferry/storage';
import {
  CloudOutboxMirror,
  CloudSyncWorker,
  SupabaseVaultSecretStore,
  migrateLocalKeysToVault,
  mapCloudRow,
  redactCloudPayload,
  type FerrySupabaseClient,
} from '../src/index.js';

vi.setConfig({ testTimeout: 30_000 });

describe('cloud mirror and worker', () => {
  it('maps pinned selection separately from the last model and maps message fields', () => {
    const session = mapCloudRow(
      'sessions',
      'ses_1',
      {
        id: 'ses_1',
        workspaceId: 'wsp_1',
        modelRef: 'openai/gpt-4o',
        pinnedModelRef: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
        starred: true,
        pinned: false,
        profileId: 'profile_default',
      },
      true,
    );
    expect(session.selected_model).toBe('auto');
    expect(session.pinned_model).toBeNull();
    expect((session.metadata as Record<string, unknown>).lastModelRef).toBe('openai/gpt-4o');
    expect(session).toMatchObject({
      workspace_id: 'wsp_1',
      starred: true,
      pinned: false,
      agent_profile_id: 'profile_default',
    });
    const message = mapCloudRow(
      'messages',
      'msg_1',
      {
        id: 'msg_1',
        sessionId: 'ses_1',
        role: 'assistant',
        agentRole: 'editor',
        createdAt: '2026-01-03T00:00:00.000Z',
        parts: [
          { type: 'text', text: 'answer' },
          { type: 'reasoning', text: 'why' },
        ],
      },
      true,
    );
    expect(message).toMatchObject({
      role: 'assistant',
      agent_role: 'editor',
      created_at: '2026-01-03T00:00:00.000Z',
      content_text: 'answer',
    });
  });

  it('redacts common provider tokens and nested credential fields', () => {
    const clean = JSON.stringify(
      redactCloudPayload({
        apiKey: 'AIza' + 'a'.repeat(30),
        password: 'do-not-leak',
        text: 'sk-or-v1-1234567890 gsk_1234567890 sb_secret_1234567890 sb_publishable_1234567890 Bearer abc.def eyJheader.eyJpayload.signature',
      }),
    );
    expect(clean).not.toContain('AIza');
    expect(clean).not.toContain('do-not-leak');
    expect(clean).not.toContain('sk-or-v1');
    expect(clean).not.toContain('gsk_');
    expect(clean).not.toContain('sb_secret_');
    expect(clean).not.toContain('sb_publishable_');
    expect(clean).not.toContain('Bearer abc.def');
    expect(clean).not.toContain('eyJheader.eyJpayload.signature');
  });
  it('maps and redacts content into durable outbox rows', async () => {
    const db = await openDatabase(':memory:');
    try {
      const outbox = new OutboxRepository(db.client);
      const mirror = new CloudOutboxMirror(outbox, false);
      mirror.onPut('messages', {
        id: 'msg_a',
        sessionId: 'ses_a',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'sk-1234567890' },
          { type: 'reasoning', text: 'private thought' },
        ],
      });
      const row = outbox.claimDue(1)[0];
      expect(row?.target).toBe('messages');
      expect(row?.payloadJson).not.toContain('private thought');
      expect(row?.payloadJson).not.toContain('sk-1234567890');
      expect(row?.payloadJson).toContain('content capture off');
    } finally {
      db.close();
    }
  });

  it('batches consecutive upserts and deletes completed outbox rows', async () => {
    const db = await openDatabase(':memory:');
    const calls: unknown[] = [];
    try {
      const outbox = new OutboxRepository(db.client);
      outbox.enqueue({ opId: 'one', target: 'sessions', op: 'upsert', payload: { id: 'ses_1' } });
      outbox.enqueue({ opId: 'two', target: 'sessions', op: 'upsert', payload: { id: 'ses_2' } });
      const fake = {
        schema: () => ({
          from: () => ({
            upsert: (payload: unknown, options: unknown) => {
              calls.push([payload, options]);
              return Promise.resolve({ error: null });
            },
          }),
        }),
      } as unknown as FerrySupabaseClient;
      const worker = new CloudSyncWorker(fake, outbox);
      worker.setSignedIn(false);
      // Set auth without triggering the background flush, then exercise the explicit bounded flush.
      worker.setSignedIn(true);
      await worker.flush({ timeoutMs: 500 });
      await Promise.resolve();
      expect(calls[0]).toEqual([[{ id: 'ses_1' }, { id: 'ses_2' }], { onConflict: 'user_id,id' }]);
      expect(outbox.counts().pending).toBe(0);
    } finally {
      db.close();
    }
  });

  it('drains persisted operations with a new worker and sends a duplicate op id once', async () => {
    const db = await openDatabase(':memory:');
    const calls: unknown[] = [];
    try {
      const outbox = new OutboxRepository(db.client);
      outbox.enqueue({
        opId: 'sessions:restart',
        target: 'sessions',
        op: 'upsert',
        payload: { id: 'restart', title: 'first' },
      });
      outbox.enqueue({
        opId: 'sessions:restart',
        target: 'sessions',
        op: 'upsert',
        payload: { id: 'restart', title: 'newest' },
      });
      const firstWorker = new CloudSyncWorker({} as FerrySupabaseClient, outbox);
      await firstWorker.flush({ timeoutMs: 20 });
      const nextWorker = new CloudSyncWorker(
        {
          schema: () => ({
            from: () => ({
              upsert: (payload: unknown) => {
                calls.push(payload);
                return Promise.resolve({ error: null });
              },
            }),
          }),
        } as unknown as FerrySupabaseClient,
        outbox,
      );
      nextWorker.setSignedIn(true);
      const deadline = Date.now() + 1_000;
      while (outbox.counts().pending && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 1));
      expect(calls).toEqual([{ id: 'restart', title: 'newest' }]);
      expect(outbox.counts().pending).toBe(0);
      firstWorker.stop();
      nextWorker.stop();
    } finally {
      db.close();
    }
  });

  it('retries a network failure and succeeds on a later drain', async () => {
    const db = await openDatabase(':memory:');
    let fail = true;
    try {
      const outbox = new OutboxRepository(db.client);
      outbox.enqueue({
        opId: 'retry',
        target: 'sessions',
        op: 'upsert',
        payload: { id: 'ses_retry' },
      });
      const fake = {
        schema: () => ({
          from: () => ({
            upsert: () =>
              Promise.resolve({
                error: fail ? { message: 'network disconnected', code: 'FETCH_ERROR' } : null,
              }),
          }),
        }),
      } as unknown as FerrySupabaseClient;
      const worker = new CloudSyncWorker(fake, outbox);
      // setSignedIn triggers an initial drain. The persisted operation remains pending after failure.
      worker.setSignedIn(true);
      const attemptDeadline = Date.now() + 1_000;
      while (Date.now() < attemptDeadline) {
        const attempt = db.client
          .prepare("SELECT attempts FROM cloud_outbox WHERE op_id='retry'")
          .get() as { attempts: number } | undefined;
        if ((attempt?.attempts ?? 0) > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      expect(outbox.counts().pending).toBe(1);
      db.client
        .prepare("UPDATE cloud_outbox SET next_attempt_at=? WHERE op_id='retry'")
        .run(new Date(0).toISOString());
      fail = false;
      await worker.flush({ timeoutMs: 500 });
      expect(outbox.counts().pending).toBe(0);
      worker.stop();
    } finally {
      db.close();
    }
  });

  it('retains the newer coalesced payload when an older send completes in flight', async () => {
    const db = await openDatabase(':memory:');
    const sent: unknown[] = [];
    let releaseFirst: (() => void) | undefined;
    let firstStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    try {
      const outbox = new OutboxRepository(db.client);
      outbox.enqueue({
        opId: 'sessions:race',
        target: 'sessions',
        op: 'upsert',
        payload: { id: 'race', title: 'old' },
      });
      const fake = {
        schema: () => ({
          from: () => ({
            upsert: (payload: unknown) => {
              sent.push(payload);
              if (sent.length === 1)
                return new Promise((resolve) => {
                  releaseFirst = () => {
                    resolve({ error: null });
                  };
                  firstStarted?.();
                });
              return Promise.resolve({ error: null });
            },
          }),
        }),
      } as unknown as FerrySupabaseClient;
      const worker = new CloudSyncWorker(fake, outbox);
      worker.setSignedIn(true);
      await started;
      outbox.enqueue({
        opId: 'sessions:race',
        target: 'sessions',
        op: 'upsert',
        payload: { id: 'race', title: 'new' },
      });
      releaseFirst?.();
      const deadline = Date.now() + 1_000;
      while (outbox.counts().pending && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 1));
      expect(sent).toEqual([
        { id: 'race', title: 'old' },
        { id: 'race', title: 'new' },
      ]);
      expect(outbox.counts().pending).toBe(0);
      worker.stop();
    } finally {
      db.close();
    }
  });

  it('retries foreign key errors and makes permission failures permanent at the injected cap', async () => {
    const db = await openDatabase(':memory:');
    let childAttempts = 0;
    try {
      const outbox = new OutboxRepository(db.client);
      outbox.enqueue({
        opId: 'sessions:parent',
        target: 'sessions',
        op: 'upsert',
        payload: { id: 'parent' },
      });
      outbox.enqueue({
        opId: 'messages:child',
        target: 'messages',
        op: 'upsert',
        payload: { id: 'child' },
      });
      outbox.enqueue({ opId: 'logs:bad', target: 'logs', op: 'insert', payload: { id: 'bad' } });
      const fake = {
        schema: () => ({
          from: (table: string) => ({
            upsert: () =>
              Promise.resolve({
                error:
                  table === 'messages' && childAttempts++ === 0
                    ? { code: '23503', message: 'foreign key violation' }
                    : null,
              }),
            insert: () =>
              Promise.resolve({ error: { code: '42501', message: 'permission denied' } }),
          }),
        }),
      } as unknown as FerrySupabaseClient;
      const worker = new CloudSyncWorker(fake, outbox, 'ferry', undefined, {
        backoffMs: () => 0,
        jitter: () => 1,
        permanentAttemptCap: 1,
        foreignKeyAttemptCap: 3,
        now: () => Date.now(),
      });
      worker.setSignedIn(true);
      await worker.flush({ timeoutMs: 1_000 });
      const deadline = Date.now() + 1_000;
      while (outbox.counts().pending && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 1));
      expect(childAttempts).toBeGreaterThanOrEqual(2);
      expect(outbox.counts().failedPermanent).toBe(1);
      worker.stop();
    } finally {
      db.close();
    }
  });

  it('sends provider secrets only to Vault RPCs and never enqueues them', async () => {
    const db = await openDatabase(':memory:');
    const calls: unknown[] = [];
    try {
      const fake = {
        schema: () => ({
          rpc: (name: string, args: unknown) => {
            calls.push([name, args]);
            return Promise.resolve({ data: 'openai:1', error: null });
          },
        }),
      } as unknown as FerrySupabaseClient;
      const store = new SupabaseVaultSecretStore(fake);
      await store.set('openai:1', 'secret-value-not-for-outbox');
      expect(calls).toEqual([
        [
          'set_provider_key',
          {
            p_provider_id: 'openai',
            p_secret: 'secret-value-not-for-outbox',
            p_label: null,
            p_key_id: 'openai:1',
          },
        ],
      ]);
      expect(new OutboxRepository(db.client).claimDue(5)).toHaveLength(0);
      expect(JSON.stringify(calls)).toContain('secret-value-not-for-outbox');
    } finally {
      db.close();
    }
  });

  it('avoids Vault calls while signed out and migrates local refs using Ferry ids', async () => {
    const calls: unknown[] = [];
    const fake = {
      schema: () => ({
        rpc: (name: string, args: unknown) => {
          calls.push([name, args]);
          return Promise.resolve({ data: null, error: null });
        },
      }),
    } as unknown as FerrySupabaseClient;
    const signedOut = new SupabaseVaultSecretStore(fake, 'ferry', undefined, () => false);
    expect(await signedOut.get('openai:1')).toBeUndefined();
    await expect(signedOut.set('openai:1', 'private')).rejects.toThrow(
      'Cloud sign-in required to manage provider keys',
    );
    await expect(signedOut.delete('openai:1')).rejects.toThrow(
      'Cloud sign-in required to manage provider keys',
    );
    expect(calls).toEqual([]);
    const vault = new SupabaseVaultSecretStore(fake);
    const counts = await migrateLocalKeysToVault({
      local: {
        get: (ref) => Promise.resolve(ref === 'openai:1' ? 'local-secret' : undefined),
        set: () => Promise.resolve(),
        delete: () => Promise.resolve(),
        has: () => Promise.resolve(false),
      },
      vault,
      entries: [
        { id: 'openai:1', providerId: 'openai', keyringRef: 'openai:1' },
        { id: 'oauth:github', providerId: 'oauth', keyringRef: 'oauth:github' },
      ],
    });
    expect(counts).toEqual({ migrated: 1, missing: 1, failed: 0 });
    expect(calls).toEqual([
      [
        'set_provider_key',
        { p_provider_id: 'openai', p_secret: 'local-secret', p_label: null, p_key_id: 'openai:1' },
      ],
    ]);
    expect(JSON.stringify(calls)).not.toContain('cloud_outbox');
  });

  it('never mirrors provider keyring references or key-shaped fields', async () => {
    const db = await openDatabase(':memory:');
    try {
      const outbox = new OutboxRepository(db.client);
      new CloudOutboxMirror(outbox).onPut('provider_key_entries', {
        id: 'openai:1',
        providerId: 'openai',
        keyId: '1',
        keyringRef: 'secret-ref',
        secret: 'sk-1234567890123456',
      });
      const payload = outbox.claimDue(1)[0]?.payloadJson ?? '';
      expect(outbox.claimDue(1)[0]?.target).toBe('provider_keys');
      expect(payload).not.toContain('keyringRef');
      expect(payload).not.toContain('secret-ref');
      expect(payload).not.toContain('sk-1234567890123456');
    } finally {
      db.close();
    }
  });

  it('updates only allowed provider key metadata after Vault has created the row', async () => {
    const db = await openDatabase(':memory:');
    const updates: unknown[] = [];
    try {
      const outbox = new OutboxRepository(db.client);
      new CloudOutboxMirror(outbox).onPut('provider_key_entries', {
        id: 'openai:1',
        providerId: 'openai',
        keyId: '1',
        keyringRef: 'private-ref',
        label: 'Primary',
        position: 0,
        enabled: true,
        status: 'ok',
        lastError: null,
        cooldownUntil: null,
      });
      const fake = {
        schema: () => ({
          from: (table: string) => ({
            update: (payload: unknown) => ({
              eq: (key: string, id: string) => {
                updates.push([table, payload, key, id]);
                return Promise.resolve({ error: null });
              },
            }),
          }),
        }),
      } as unknown as FerrySupabaseClient;
      const worker = new CloudSyncWorker(fake, outbox);
      worker.setSignedIn(true);
      const deadline = Date.now() + 1_000;
      while (outbox.counts().pending && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 1));
      expect(updates).toEqual([
        [
          'provider_keys',
          {
            label: 'Primary',
            position: 0,
            enabled: true,
            status: 'ok',
            last_error: null,
            cooldown_until: null,
          },
          'id',
          'openai:1',
        ],
      ]);
      worker.stop();
    } finally {
      db.close();
    }
  });
});
