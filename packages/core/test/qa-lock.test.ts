import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { FERRY_PROTOCOL } from '@ferry/shared';
import {
  CoreHost,
  CoreLockError,
  createCoreHost,
  createMemoryTransportPair,
  readLockInfo,
} from '../src/index.js';

const dataDir = await mkdtemp(join(tmpdir(), 'ferry-qa-lock-'));
vi.setConfig({ testTimeout: 30_000 });
afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

async function spawnAndKill(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  const pid = child.pid;
  if (pid === undefined) throw new Error('Failed to spawn child process');
  const exited = new Promise<void>((resolve, reject) => {
    child.once('exit', () => {
      resolve();
    });
    child.once('error', reject);
  });
  child.kill('SIGKILL');
  await exited;
  return pid;
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

  it('allows exactly one of twenty concurrent starts across twenty iterations', async () => {
    for (let iteration = 0; iteration < 20; iteration += 1) {
      const path = join(dataDir, `stress-${String(iteration)}`);
      const hosts = Array.from({ length: 20 }, () => new CoreHost({ dataDir: path }));
      const results = await Promise.allSettled(hosts.map((host) => host.start()));
      const winnerIndex = results.findIndex((result) => result.status === 'fulfilled');
      const winners = results.filter((result) => result.status === 'fulfilled');
      const losers = results.filter((result) => result.status === 'rejected');
      const outcome = results
        .map((result, index) => {
          if (result.status === 'fulfilled') return `${String(index)}:winner`;
          return `${String(index)}:${result.reason instanceof Error ? `${result.reason.name}:${result.reason.message}` : String(result.reason)}`;
        })
        .join(' | ');
      expect(winners, `iteration ${String(iteration)} outcomes: ${outcome}`).toHaveLength(1);
      expect(losers, `iteration ${String(iteration)} outcomes: ${outcome}`).toHaveLength(19);
      expect(
        losers.every((result) => result.reason instanceof CoreLockError),
        `iteration ${String(iteration)} outcomes: ${outcome}`,
      ).toBe(true);
      const winner = hosts[winnerIndex];
      if (!winner) throw new Error('Expected a winning host');
      await winner.stop();
    }
  }, 60_000);

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
    const lockPath = join(path, 'core.lock');
    await writeFile(lockPath, '{"pid":', 'utf8');
    await expect(new CoreHost({ dataDir: path }).start()).rejects.toBeInstanceOf(CoreLockError);
    const staleTime = new Date(Date.now() - 10_000);
    await utimes(lockPath, staleTime, staleTime);
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
  }, 30_000);
});
