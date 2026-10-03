import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createGatewayKey, type GatewayKey } from '@ferry/gateway';
import { openDatabase, SettingsRepository } from '@ferry/storage';
import { canonicalizePath } from '@ferry/shared/node-paths';
import { resolveEngineDataDirectory } from './data-directory.js';

export interface GatewayStatusFile {
  pid: number;
  port: number;
  host: string;
  url: string;
}

export function gatewayDataDir(dataDir?: string): string {
  return canonicalizePath(resolveEngineDataDirectory(dataDir));
}

export async function writeGatewayStatus(
  dataDir: string,
  status: Omit<GatewayStatusFile, 'pid'>,
): Promise<void> {
  dataDir = canonicalizePath(dataDir);
  await mkdir(dataDir, { recursive: true });
  await writeFile(
    join(dataDir, 'gateway-status.json'),
    JSON.stringify({ pid: process.pid, ...status }),
    'utf8',
  );
}

export async function clearGatewayStatus(dataDir: string): Promise<void> {
  await rm(join(canonicalizePath(dataDir), 'gateway-status.json'), { force: true });
}

async function statusFile(dataDir: string): Promise<GatewayStatusFile | undefined> {
  try {
    return JSON.parse(
      await readFile(join(canonicalizePath(dataDir), 'gateway-status.json'), 'utf8'),
    ) as GatewayStatusFile;
  } catch {
    return undefined;
  }
}

export async function startGatewayDaemon(dataDir: string): Promise<GatewayStatusFile> {
  dataDir = canonicalizePath(dataDir);
  const previous = await statusFile(dataDir);
  if (previous && (await isRunning(previous))) return previous;
  const args = [process.argv[1] ?? 'ferry', 'serve', '--gateway', '--data-dir', dataDir];
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const current = await statusFile(dataDir);
    if (current && (await isRunning(current))) return current;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error('Gateway process did not become ready within 15 seconds. Check Ferry logs.');
}

async function isRunning(status: GatewayStatusFile): Promise<boolean> {
  if (!Number.isSafeInteger(status.pid) || status.pid <= 1 || status.pid === process.pid)
    return false;
  try {
    process.kill(status.pid, 0);
    const response = await fetch(`${status.url}/health`, { signal: AbortSignal.timeout(1_000) });
    return response.ok;
  } catch {
    return false;
  }
}

export async function getGatewayDaemonStatus(
  dataDir: string,
): Promise<GatewayStatusFile | undefined> {
  const status = await statusFile(dataDir);
  return status && (await isRunning(status)) ? status : undefined;
}

export async function stopGatewayDaemon(dataDir: string): Promise<boolean> {
  const status = await statusFile(dataDir);
  if (!status || !(await isRunning(status))) {
    await clearGatewayStatus(dataDir);
    return false;
  }
  if (!Number.isSafeInteger(status.pid) || status.pid <= 1 || status.pid === process.pid)
    throw new Error('Refusing to stop an invalid gateway process ID.');
  process.kill(status.pid, 'SIGTERM');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!(await isRunning(status))) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error('Gateway did not stop within 10 seconds.');
}

async function withSettings<T>(
  dataDir: string,
  run: (settings: SettingsRepository) => T,
): Promise<T> {
  const db = await openDatabase(join(canonicalizePath(dataDir), 'db', 'ferry.sqlite'));
  try {
    return run(new SettingsRepository(db.client));
  } finally {
    db.close();
  }
}

export async function createGatewayToken(dataDir: string, name: string, profile: string) {
  const created = createGatewayKey({ name, profile });
  await withSettings(dataDir, (settings) => {
    const current = settings.get('gateway-keys');
    const entries = Array.isArray(current) ? (current as GatewayKey[]) : [];
    settings.put('gateway-keys', [...entries, created.key]);
  });
  const { hash: _hash, ...key } = created.key;
  return { key, secret: created.secret };
}

export async function listGatewayTokens(dataDir: string) {
  return await withSettings(dataDir, (settings) => {
    const stored = settings.get('gateway-keys');
    const entries = Array.isArray(stored) ? (stored as GatewayKey[]) : [];
    return entries.map(({ hash: _hash, ...key }) => ({
      ...key,
      usage: settings.get(`gateway-usage:${key.id}`) ?? {
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
      },
    }));
  });
}

export async function revokeGatewayToken(dataDir: string, id: string): Promise<boolean> {
  return await withSettings(dataDir, (settings) => {
    const stored = settings.get('gateway-keys');
    const entries = Array.isArray(stored) ? (stored as GatewayKey[]) : [];
    let found = false;
    settings.put(
      'gateway-keys',
      entries.map((key) => {
        if (key.id !== id) return key;
        found = true;
        return { ...key, revokedAt: new Date().toISOString() };
      }),
    );
    return found;
  });
}
