import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createRpcFerryClient, RpcError, type RpcFerryClient } from '@ferry/client';
import { SettingsSchema, SystemInfoSchema } from '@ferry/shared';
import type { CheckpointId, SessionId, WorkspaceId } from '@ferry/shared';
import { ShadowCheckpoints, WorkspaceJail } from '@ferry/workspace';
import { openDatabase } from '@ferry/storage';
import { CoreHost, createCoreHost, createMemoryTransportPair, readLockInfo } from '../src/index.js';

const dataDir = await mkdtemp(join(tmpdir(), 'ferry-qa-domains-'));
afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

interface Harness {
  dir: string;
  host: CoreHost;
  rpc: RpcFerryClient;
  close(): Promise<void>;
}

async function makeCore(name: string): Promise<Harness> {
  const dir = join(dataDir, name);
  const [coreTransport, clientTransport] = createMemoryTransportPair();
  const host = await createCoreHost({ dataDir: dir, transport: coreTransport });
  const rpc = createRpcFerryClient(clientTransport, { timeoutMs: 5000 });
  await rpc.hello;
  return {
    dir,
    host,
    rpc,
    async close() {
      rpc.close();
      await host.stop();
    },
  };
}

async function errorOf(promise: Promise<unknown>): Promise<RpcError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RpcError) return error;
    throw error;
  }
  throw new Error('Expected the call to reject');
}

describe('QA settings domain', () => {
  it('rejects invalid values with the validation taxonomy and a Zod-backed message', async () => {
    const core = await makeCore('settings-invalid');
    try {
      const themeError = await errorOf(core.rpc.settings.update({ theme: 'neon' } as never));
      expect(themeError).toMatchObject({ code: -32010, kind: 'validation' });

      const scaleError = await errorOf(core.rpc.settings.update({ fontScale: 5 }));
      expect(scaleError).toMatchObject({ code: -32010, kind: 'validation' });

      const developerError = await errorOf(
        core.rpc.settings.update({ developer: { realDomains: [123] } } as never),
      );
      expect(developerError).toMatchObject({ code: -32010, kind: 'validation' });
    } finally {
      await core.close();
    }
  });

  it('merges nested optimizers/developer patches instead of replacing them', async () => {
    const core = await makeCore('settings-merge');
    try {
      const before = await core.rpc.settings.get();
      const after = await core.rpc.settings.update({
        optimizers: { ...before.optimizers, terse: 'full' },
        developer: { ...before.developer, mockLatency: true },
      } as never);
      expect(after.optimizers.terse).toBe('full');
      expect(after.optimizers.contextHygiene).toBe(before.optimizers.contextHygiene);
      expect(after.developer.mockLatency).toBe(true);
      expect(after.developer.showReferenceOverlay).toBe(before.developer.showReferenceOverlay);
      const partial = await core.rpc.settings.update({ fontScale: 1.2 });
      expect(partial.optimizers.terse).toBe('full');
      expect(partial.developer.mockLatency).toBe(true);
    } finally {
      await core.close();
    }
  });

  it('persists settings across a core restart', async () => {
    const first = await makeCore('settings-persist');
    const dir = first.dir;
    await first.rpc.settings.update({ theme: 'light', fontScale: 1.25 });
    await first.close();

    const [coreTransport, clientTransport] = createMemoryTransportPair();
    const host = await createCoreHost({ dataDir: dir, transport: coreTransport });
    const rpc = createRpcFerryClient(clientTransport, { timeoutMs: 5000 });
    await rpc.hello;
    try {
      const settings = await rpc.settings.get();
      expect(settings.theme).toBe('light');
      expect(settings.fontScale).toBe(1.25);
      SettingsSchema.parse(settings);
    } finally {
      rpc.close();
      await host.stop();
    }
  });

  it('applies concurrent updates without losing either patch', async () => {
    const core = await makeCore('settings-concurrent');
    try {
      await Promise.all([
        core.rpc.settings.update({ theme: 'light' }),
        core.rpc.settings.update({ fontScale: 1.2 }),
        core.rpc.settings.update({ restoreTabs: false }),
      ]);
      const settings = await core.rpc.settings.get();
      expect(settings.theme).toBe('light');
      expect(settings.fontScale).toBe(1.2);
      expect(settings.restoreTabs).toBe(false);
    } finally {
      await core.close();
    }
  });

  it('runs migrations idempotently when the database is reopened', async () => {
    const dir = join(dataDir, 'settings-migrations');
    const first = await openDatabase(join(dir, 'db', 'ferry.sqlite'));
    const version = first.client.pragma('user_version', { simple: true });
    first.close();
    const second = await openDatabase(join(dir, 'db', 'ferry.sqlite'));
    try {
      expect(Number(version)).toBe(1);
      expect(Number(second.client.pragma('user_version', { simple: true }))).toBe(1);
    } finally {
      second.close();
    }
  });

  it('fails with a clear error on a corrupt SQLite file and recovers after removal', async () => {
    const dir = join(dataDir, 'settings-corrupt');
    await mkdir(join(dir, 'db'), { recursive: true });
    await writeFile(join(dir, 'db', 'ferry.sqlite'), 'definitely not sqlite', 'utf8');
    const failure = await createCoreHost({ dataDir: dir }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/not a database|malformed|corrupt|sqlite/i);
    await expect(readLockInfo(dir)).resolves.toBeNull();

    await rm(join(dir, 'db', 'ferry.sqlite'), { force: true });
    const recovered = await createCoreHost({ dataDir: dir });
    try {
      const settings = (await recovered.dispatch({
        jsonrpc: '2.0',
        id: 1,
        method: 'settings.get',
        params: [],
      })) as { theme: string };
      expect(settings.theme).toBeTruthy();
    } finally {
      await recovered.stop();
    }
  });
});

// BUG (Windows): the same folder opened with different case creates a second
// workspace row; lookups compare `path.resolve` strings case-sensitively.
describe.runIf(process.platform === 'win32')('QA workspaces case-insensitive paths', () => {
  it.fails('dedupes the same folder case-insensitively', async () => {
    const core = await makeCore('ws-case');
    try {
      await mkdir(join(core.dir, 'work'), { recursive: true });
      const real = join(core.dir, 'work');
      const opened = await core.rpc.workspaces.open(real);
      const upper = await core.rpc.workspaces.open(real.toUpperCase());
      expect(upper.id).toBe(opened.id);
    } finally {
      await core.close();
    }
  });
});

describe('QA workspaces domain', () => {
  it('rejects a path that is a file with a validation error', async () => {
    const core = await makeCore('ws-file');
    try {
      await mkdir(join(core.dir, 'work'), { recursive: true });
      const file = join(core.dir, 'a.txt');
      await writeFile(file, 'x', 'utf8');
      const error = await errorOf(core.rpc.workspaces.open(file));
      expect(error).toMatchObject({ code: -32010, kind: 'validation' });
    } finally {
      await core.close();
    }
  });

  it('rejects empty and non-string paths with a validation error', async () => {
    const core = await makeCore('ws-bad-input');
    try {
      expect(await errorOf(core.rpc.workspaces.open(''))).toMatchObject({ kind: 'validation' });
      expect(await errorOf(core.rpc.workspaces.open(undefined as never))).toMatchObject({
        kind: 'validation',
      });
    } finally {
      await core.close();
    }
  });

  // BUG: a non-existent path throws a raw ENOENT from `stat` that is mapped to
  // internal (-32603) instead of a typed not_found/validation error.
  it.fails('reports a missing workspace path as a typed not_found/validation error', async () => {
    const core = await makeCore('ws-missing');
    try {
      const error = await errorOf(core.rpc.workspaces.open(join(core.dir, 'does-not-exist')));
      expect(['not_found', 'validation']).toContain(error.kind);
    } finally {
      await core.close();
    }
  });

  it('resolves relative paths and dedupes redundant path segments', async () => {
    const core = await makeCore('ws-relative');
    try {
      await mkdir(join(core.dir, 'work', 'sub'), { recursive: true });
      const target = join(core.dir, 'work', 'sub');
      const opened = await core.rpc.workspaces.open(relative(process.cwd(), target));
      expect(opened.path).toBe(target);
      const again = await core.rpc.workspaces.open(join(target, '.', '..', 'sub'));
      expect(again.id).toBe(opened.id);
      expect((await core.rpc.workspaces.list()).filter((w) => w.path === target)).toHaveLength(1);
    } finally {
      await core.close();
    }
  });

  it('detects language for a non-git folder and leaves gitBranch null', async () => {
    const core = await makeCore('ws-language');
    try {
      const dir = join(core.dir, 'python-app');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'main.py'), 'print(1)\n', 'utf8');
      const workspace = await core.rpc.workspaces.open(dir);
      expect(workspace.gitBranch).toBeNull();
      expect(workspace.language).toBe('py');
      const tsDir = join(core.dir, 'ts-app');
      await mkdir(tsDir, { recursive: true });
      await writeFile(join(tsDir, 'index.ts'), 'export {};\n', 'utf8');
      expect((await core.rpc.workspaces.open(tsDir)).language).toBe('ts');
    } finally {
      await core.close();
    }
  });

  it('keeps a workspace listed after its folder is deleted, and reopening fails', async () => {
    const core = await makeCore('ws-deleted');
    try {
      const dir = join(core.dir, 'gone');
      await mkdir(dir, { recursive: true });
      const opened = await core.rpc.workspaces.open(dir);
      await rm(dir, { recursive: true, force: true });
      expect((await core.rpc.workspaces.list()).some((w) => w.id === opened.id)).toBe(true);
      await expect(core.rpc.workspaces.open(dir)).rejects.toBeInstanceOf(RpcError);
    } finally {
      await core.close();
    }
  });

  it('reports not_found for updates/removals of unknown workspaces', async () => {
    const core = await makeCore('ws-unknown');
    try {
      const missing = 'workspace_missing' as WorkspaceId;
      expect(await errorOf(core.rpc.workspaces.update(missing, {}))).toMatchObject({
        code: -32044,
        kind: 'not_found',
      });
      expect(await errorOf(core.rpc.workspaces.remove(missing))).toMatchObject({
        code: -32044,
        kind: 'not_found',
      });
    } finally {
      await core.close();
    }
  });

  it('emits workspace.updated on open and workspace.removed on remove', async () => {
    const core = await makeCore('ws-events');
    try {
      const dir = join(core.dir, 'events');
      await mkdir(dir, { recursive: true });
      const opened = await core.rpc.workspaces.open(dir);
      const updated: string[] = [];
      const removed: string[] = [];
      core.rpc.on('workspace.updated', (workspace) => updated.push(workspace.id));
      core.rpc.on('workspace.removed', (payload) => removed.push(payload.id));
      await core.rpc.workspaces.open(dir);
      await core.rpc.workspaces.remove(opened.id);
      expect(updated).toContain(opened.id);
      expect(removed).toEqual([opened.id]);
    } finally {
      await core.close();
    }
  });
});

describe('QA checkpoints domain', () => {
  async function setup(name: string) {
    const core = await makeCore(name);
    const workspaceDir = join(core.dir, 'work');
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(join(workspaceDir, 'a.txt'), 'one\n', 'utf8');
    const workspace = await core.rpc.workspaces.open(workspaceDir);
    const shadow = new ShadowCheckpoints(new WorkspaceJail(workspaceDir), core.dir);
    return { core, workspaceDir, workspace, shadow };
  }

  it('diffs, lists and restores a checkpoint', async () => {
    const { core, workspaceDir, shadow } = await setup('cp-happy');
    try {
      await writeFile(join(workspaceDir, 'a.txt'), 'one\n', 'utf8');
      const id = (await shadow.snapshot('Before change')) as CheckpointId;
      await writeFile(join(workspaceDir, 'a.txt'), 'two\n', 'utf8');
      const diff = await core.rpc.checkpoints.diff(id);
      expect(diff).toContain('a.txt');
      const sessionId = 'qa_session' as SessionId;
      expect((await core.rpc.checkpoints.list(sessionId)).map((c) => c.id)).toContain(id);
      await core.rpc.checkpoints.restore(id);
      expect(await readFile(join(workspaceDir, 'a.txt'), 'utf8')).toBe('one\n');
    } finally {
      await core.close();
    }
  }, 30_000);

  it('restores twice idempotently', async () => {
    const { core, workspaceDir, shadow } = await setup('cp-twice');
    try {
      const id = (await shadow.snapshot('twice')) as CheckpointId;
      await writeFile(join(workspaceDir, 'a.txt'), 'changed\n', 'utf8');
      await core.rpc.checkpoints.restore(id);
      const first = await readFile(join(workspaceDir, 'a.txt'), 'utf8');
      await core.rpc.checkpoints.restore(id);
      const second = await readFile(join(workspaceDir, 'a.txt'), 'utf8');
      expect(first).toBe('one\n');
      expect(second).toBe('one\n');
    } finally {
      await core.close();
    }
  }, 30_000);

  // BUG: single-file restore uses `git show` through execa, which strips the
  // trailing newline, so the restored file loses its final EOL.
  it.fails(
    'restores only the requested path without dropping its trailing newline',
    async () => {
      const { core, workspaceDir, shadow } = await setup('cp-subset');
      try {
        await writeFile(join(workspaceDir, 'b.txt'), 'keep\n', 'utf8');
        const id = (await shadow.snapshot('subset')) as CheckpointId;
        await writeFile(join(workspaceDir, 'a.txt'), 'changed\n', 'utf8');
        await writeFile(join(workspaceDir, 'b.txt'), 'changed-b\n', 'utf8');
        await core.rpc.checkpoints.restore(id, ['a.txt']);
        const restoredA = await readFile(join(workspaceDir, 'a.txt'), 'utf8');
        const untouchedB = await readFile(join(workspaceDir, 'b.txt'), 'utf8');
        expect(restoredA).toBe('one\n');
        expect(untouchedB).toBe('changed-b\n');
      } finally {
        await core.close();
      }
    },
    30_000,
  );

  it('diffs binary files without throwing and preserves CRLF on restore', async () => {
    const { core, workspaceDir, shadow } = await setup('cp-binary');
    try {
      await writeFile(join(workspaceDir, 'bin.dat'), Buffer.from([0, 1, 2, 3, 0, 255]), 'binary');
      await writeFile(join(workspaceDir, 'crlf.txt'), 'line1\r\nline2\r\n', 'utf8');
      const id = (await shadow.snapshot('binary')) as CheckpointId;
      await writeFile(join(workspaceDir, 'bin.dat'), Buffer.from([0, 9, 9, 0, 255, 7]), 'binary');
      await writeFile(join(workspaceDir, 'crlf.txt'), 'line1\r\nchanged\r\n', 'utf8');
      const diff = await core.rpc.checkpoints.diff(id);
      expect(diff).toMatch(/Binary files/i);
      await core.rpc.checkpoints.restore(id);
      expect(Array.from(await readFile(join(workspaceDir, 'bin.dat')))).toEqual([
        0, 1, 2, 3, 0, 255,
      ]);
      expect(await readFile(join(workspaceDir, 'crlf.txt'), 'utf8')).toBe('line1\r\nline2\r\n');
    } finally {
      await core.close();
    }
  }, 30_000);

  // BUG: restoring a checkpoint whose workspace folder was deleted reports
  // not_found ("Checkpoint not found") even though the checkpoint data is intact;
  // the work tree cannot be recreated.
  it.fails(
    'restores a checkpoint when the workspace folder was deleted',
    async () => {
      const { core, workspaceDir, shadow } = await setup('cp-deleted');
      try {
        const id = (await shadow.snapshot('deleted')) as CheckpointId;
        await writeFile(join(workspaceDir, 'a.txt'), 'changed\n', 'utf8');
        await rm(workspaceDir, { recursive: true, force: true });
        await expect(core.rpc.checkpoints.restore(id)).resolves.toBeUndefined();
        expect(await readFile(join(workspaceDir, 'a.txt'), 'utf8')).toBe('one\n');
      } finally {
        await core.close();
      }
    },
    30_000,
  );

  it('reports not_found for unknown checkpoints and validation for bad ids', async () => {
    const core = await makeCore('cp-unknown');
    try {
      const unknown = 'a'.repeat(40) as CheckpointId;
      expect(await errorOf(core.rpc.checkpoints.diff(unknown))).toMatchObject({
        code: -32044,
        kind: 'not_found',
      });
      expect(await errorOf(core.rpc.checkpoints.restore(unknown))).toMatchObject({
        code: -32044,
        kind: 'not_found',
      });
      expect(await errorOf(core.rpc.checkpoints.diff('' as CheckpointId))).toMatchObject({
        kind: 'validation',
      });
      expect(await errorOf(core.rpc.checkpoints.list('' as SessionId))).toMatchObject({
        kind: 'validation',
      });
    } finally {
      await core.close();
    }
  });
});

describe('QA system domain', () => {
  it('reports valid system info and the registered real domains', async () => {
    const core = await makeCore('system-info');
    try {
      const info = await core.rpc.system.info();
      SystemInfoSchema.parse(info);
      expect(info.mock).toBe(false);
      expect(info.dataDir).toBe(core.dir);
      expect(info.realDomains).toEqual(
        expect.arrayContaining(['settings', 'workspaces', 'checkpoints']),
      );
      expect(core.rpc.implementedMethods).toContain('settings.update');
      expect(core.rpc.implementedMethods).not.toContain('sessions.send');
    } finally {
      await core.close();
    }
  });

  it('returns the self-test shape', async () => {
    const core = await makeCore('system-selftest');
    try {
      const result = (await core.host.dispatch({
        jsonrpc: '2.0',
        id: 1,
        method: 'system.selfTest',
        params: [],
      })) as { modules: unknown[] };
      expect(Array.isArray(result.modules)).toBe(true);
    } finally {
      await core.close();
    }
  });

  it('rejects a mismatched protocol during hello', async () => {
    const dir = join(dataDir, 'system-protocol');
    const [coreTransport, clientTransport] = createMemoryTransportPair();
    const host = await createCoreHost({ dataDir: dir, transport: coreTransport });
    const rpc = createRpcFerryClient(clientTransport, { timeoutMs: 2000 });
    try {
      const result = await rpc.hello;
      expect(result.protocol).toBe('ferry/1');
    } finally {
      rpc.close();
      await host.stop();
    }
    const host2 = new CoreHost({ dataDir: dir });
    await host2.start();
    try {
      await expect(
        host2.dispatch({
          jsonrpc: '2.0',
          id: 1,
          method: 'system.hello',
          params: [{ protocol: 'ferry/99', capabilities: [] }],
        }),
      ).rejects.toThrow(/ferry\/1/);
    } finally {
      await host2.stop();
    }
  });
});
