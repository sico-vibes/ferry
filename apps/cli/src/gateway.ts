import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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

async function readStatus(dataDir: string): Promise<GatewayStatusFile | undefined> {
  try {
    return JSON.parse(
      await readFile(join(canonicalizePath(dataDir), 'gateway-status.json'), 'utf8'),
    ) as GatewayStatusFile;
  } catch {
    return undefined;
  }
}

export async function getGatewayDaemonStatus(
  dataDir: string,
): Promise<GatewayStatusFile | undefined> {
  const status = await readStatus(dataDir);
  return status && gatewayProcessAlive(status.pid) && (await gatewayHealthy(status))
    ? status
    : undefined;
}

export async function startGatewayDaemon(dataDir?: string): Promise<GatewayStatusFile> {
  const resolvedDataDir = gatewayDataDir(dataDir);
  const current = await readStatus(resolvedDataDir);
  if (current && gatewayProcessAlive(current.pid)) {
    const existing = await waitForGatewayStatus(resolvedDataDir, current.pid, 15_000);
    if (existing) return existing;
  }

  const executable = process.argv[1];
  if (!executable) throw new Error('Could not locate the Ferry CLI entry point for Gateway start.');
  const child = spawn(
    process.execPath,
    [executable, 'serve', '--gateway', ...(dataDir ? ['--data-dir', dataDir] : [])],
    {
      cwd: process.cwd(),
      env: process.env,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    },
  );
  child.unref();
  const pid = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('spawn', () => {
      child.off('error', reject);
      if (child.pid === undefined) reject(new Error('Gateway process did not receive a PID'));
      else resolve(child.pid);
    });
  });
  const status = await waitForGatewayStatus(resolvedDataDir, pid, 30_000);
  if (status) return status;
  if (gatewayProcessAlive(pid)) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* The child may have exited during the readiness check. */
    }
  }
  throw new Error('Gateway process did not become ready within 30 seconds. Check Ferry logs.');
}

export async function stopGatewayDaemon(dataDir: string): Promise<boolean> {
  const status = await readStatus(dataDir);
  if (!status || status.pid === process.pid || !gatewayProcessAlive(status.pid)) {
    await clearGatewayStatus(dataDir);
    return false;
  }
  try {
    process.kill(status.pid, 'SIGTERM');
  } catch (error) {
    if (!isMissingProcess(error)) throw error;
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!gatewayProcessAlive(status.pid)) {
      await clearGatewayStatus(dataDir);
      return true;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error('Gateway process did not stop within 10 seconds.');
}

async function waitForGatewayStatus(
  dataDir: string,
  pid: number,
  timeoutMs: number,
): Promise<GatewayStatusFile | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await readStatus(dataDir);
    if (status?.pid === pid && (await gatewayHealthy(status))) return status;
    if (!gatewayProcessAlive(pid)) return undefined;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  return undefined;
}

async function gatewayHealthy(status: GatewayStatusFile): Promise<boolean> {
  if (!gatewayProcessAlive(status.pid)) return false;
  try {
    const response = await fetch(`${status.url}/health`, { signal: AbortSignal.timeout(1_000) });
    return response.ok;
  } catch {
    return false;
  }
}

function gatewayProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EPERM';
  }
}

function isMissingProcess(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH';
}
