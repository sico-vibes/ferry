import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FERRY_PROTOCOL } from '@ferry/shared';
import {
  CoreHost,
  CoreLockError,
  createCoreHost,
  createMemoryTransportPair,
  readLockInfo,
} from '../src/index.js';

const dataDir = await mkdtemp(join(tmpdir(), 'ferry-qa-lock-'));
afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function spawnAndKill(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  if (child.pid === undefined) throw new Error('Failed to spawn child process');
  await sleep(200);
  child.kill('SIGKILL');
  await new Promise<void>((resolve) => {
    child.once('exit', () => {
      resolve();
    });
  });
  await sleep(50);
  return child.pid;
}

describe('QA single-writer lock', () => {
  it('refuses a second owner with a clear CoreLockError and keeps the first usable', async () => {
    const path = join(dataDir, 'exclusive');
    const first = new CoreHost({ dataDir: path });
    await first.start();
    try {
      await expect(new CoreHost({ dataDir: path }).start()).rejects.toBeInstanceOf(CoreLockError);
      await expect(new CoreHost({ dataDir: path }).start()).rejects.toThrow(/already running/i);
      await expect(
        first.dispatch({ jsonrpc: '2.0', id: 1, method: 'system.info', params: [] }),
      ).resolves.toMatchObject({ mock: false });
    } finally {
      await first.stop();
    }
  });

  it('allows a fresh owner after the previous one stops', async () => {
    const path = join(dataDir, 'reuse');
    const first = new CoreHost({ dataDir: path });
    await first.start();
    await first.stop();
    const second = new CoreHost({ dataDir: path });
    await expect(second.start()).resolves.toBeUndefined();
    await second.stop();
  });

  it('lets exactly one of two concurrent starts win the race', async () => {
    const path = join(dataDir, 'race');
    const results = await Promise.allSettled([
      new CoreHost({ dataDir: path }).start(),
      new CoreHost({ dataDir: path }).start(),
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const rejectedResult = rejected[0];
    if (rejectedResult?.status !== 'rejected') throw new Error('Expected one rejected start');
    expect(rejectedResult.reason).toBeInstanceOf(CoreLockError);
  });

  it('writes pid and protocol into the lock file and removes it on stop', async () => {
    const path = join(dataDir, 'contents');
    const host = new CoreHost({ dataDir: path });
    await host.start();
    await expect(readLockInfo(path)).resolves.toEqual({
      pid: process.pid,
      protocol: FERRY_PROTOCOL,
    });
    const raw = JSON.parse(await readFile(join(path, 'core.lock'), 'utf8')) as { pid: number };
    expect(raw.pid).toBe(process.pid);
    await host.stop();
    await expect(readLockInfo(path)).resolves.toBeNull();
  });

  it('recovers an incomplete lock left by a crash mid-write', async () => {
    const path = join(dataDir, 'partial');
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'core.lock'), '{"pid":', 'utf8');
    const host = new CoreHost({ dataDir: path });
    await expect(host.start()).resolves.toBeUndefined();
    expect(await readLockInfo(path)).toMatchObject({ pid: process.pid });
    await host.stop();
  });

  it('recovers a stale lock whose owning process was killed -9', async () => {
    const path = join(dataDir, 'stale');
    await mkdir(path, { recursive: true });
    const deadPid = await spawnAndKill();
    await writeFile(
      join(path, 'core.lock'),
      JSON.stringify({ pid: deadPid, protocol: FERRY_PROTOCOL }),
      'utf8',
    );
    const host = new CoreHost({ dataDir: path });
    await expect(host.start()).resolves.toBeUndefined();
    expect(await readLockInfo(path)).toMatchObject({ pid: process.pid });
    await host.stop();
  });

  it('releases services and the lock when a composed core fails to acquire the lock', async () => {
    const path = join(dataDir, 'composed');
    const [coreTransport] = createMemoryTransportPair();
    const holder = await createCoreHost({ dataDir: path, transport: coreTransport });
    await expect(createCoreHost({ dataDir: path })).rejects.toBeInstanceOf(CoreLockError);
    await holder.stop();
    const next = await createCoreHost({ dataDir: path });
    try {
      const settings = (await next.dispatch({
        jsonrpc: '2.0',
        id: 1,
        method: 'settings.get',
        params: [],
      })) as { theme?: unknown };
      expect(typeof settings.theme).toBe('string');
    } finally {
      await next.stop();
    }
  });
});
