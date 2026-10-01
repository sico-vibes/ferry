import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CoreHost, createCoreHost, createMemoryTransportPair } from '../src/index.js';
import { createRpcFerryClient } from '@ferry/client';

const dataDir = await mkdtemp(join(tmpdir(), 'ferry-output-recovery-'));
afterAll(async () => rm(dataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));

async function setup(name: string) {
  const dir = join(dataDir, name);
  await mkdir(dir, { recursive: true });
  const workspaceDir = join(dir, 'workspace');
  await mkdir(workspaceDir, { recursive: true });
  const [coreTransport, clientTransport] = createMemoryTransportPair();
  const host = await createCoreHost({ dataDir: dir, transport: coreTransport });
  let rpc: ReturnType<typeof createRpcFerryClient> | undefined;
  try {
    const client = createRpcFerryClient(clientTransport, { timeoutMs: 15_000 });
    rpc = client;
    await client.hello;
    const workspace = await client.workspaces.open(workspaceDir);
    const session = await client.sessions.create({ workspaceId: workspace.id });
    return {
      host,
      rpc: client,
      workspace,
      session,
      close: async () => {
        try {
          client.close();
        } finally {
          await host.stop();
        }
      },
    };
  } catch (error) {
    await Promise.allSettled([Promise.resolve(rpc?.close()), host.stop()]);
    throw error;
  }
}

function saveBlob(
  host: CoreHost,
  input: {
    id: string;
    sessionId: string;
    workspaceId: string;
    content: string;
    sourcePath?: string;
  },
) {
  host.options.services?.db.client
    .prepare('INSERT INTO optimizer_blobs (id,data_json,updated_at) VALUES (?,?,?)')
    .run(input.id, JSON.stringify(input), new Date().toISOString());
}

describe('sessions.readOutput', () => {
  it('returns bounded pages and rejects a handle owned by another session', async () => {
    const ctx = await setup('output-page');
    try {
      const other = await ctx.rpc.sessions.create({ workspaceId: ctx.workspace.id });
      const content = 'abc😀'.repeat(15_000);
      saveBlob(ctx.host, {
        id: 'recovery_page',
        sessionId: ctx.session.id,
        workspaceId: ctx.workspace.id,
        content,
      });
      const page = await ctx.rpc.sessions.readOutput({
        sessionId: ctx.session.id,
        handle: 'recovery_page',
      });
      expect(Buffer.byteLength(page.text, 'utf8')).toBeLessThanOrEqual(32 * 1024);
      expect(page.hasMore).toBe(true);
      expect(page.end).toBe(page.text.length);
      const next = await ctx.rpc.sessions.readOutput({
        sessionId: ctx.session.id,
        handle: 'recovery_page',
        range: { start: page.end },
      });
      expect(next.text).toBe(content.slice(page.end, page.end + next.text.length));
      await expect(
        ctx.rpc.sessions.readOutput({ sessionId: other.id, handle: 'recovery_page' }),
      ).rejects.toMatchObject({ kind: 'not_found' });
    } finally {
      await ctx.close();
    }
  }, 30_000);

  it('rejects unknown handles and paths outside the owning workspace jail', async () => {
    const ctx = await setup('output-jail');
    try {
      await expect(
        ctx.rpc.sessions.readOutput({ sessionId: ctx.session.id, handle: 'missing' }),
      ).rejects.toMatchObject({ kind: 'not_found' });
      saveBlob(ctx.host, {
        id: 'recovery_escape',
        sessionId: ctx.session.id,
        workspaceId: ctx.workspace.id,
        content: 'private',
        sourcePath: '../outside.txt',
      });
      await expect(
        ctx.rpc.sessions.readOutput({ sessionId: ctx.session.id, handle: 'recovery_escape' }),
      ).rejects.toMatchObject({ kind: 'not_found' });
      saveBlob(ctx.host, {
        id: 'recovery_secret',
        sessionId: ctx.session.id,
        workspaceId: ctx.workspace.id,
        content: 'private',
        sourcePath: '.env',
      });
      await expect(
        ctx.rpc.sessions.readOutput({ sessionId: ctx.session.id, handle: 'recovery_secret' }),
      ).rejects.toMatchObject({ kind: 'not_found' });
    } finally {
      await ctx.close();
    }
  }, 30_000);
});
