import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoreHost } from '../src/index.js';
import {
  connectLocalControl,
  localControlEndpointPath,
  localControlSocketAddress,
  readLocalControlEndpoint,
  verifyLocalControlToken,
} from '../src/local-control.js';

const dataDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    dataDirectories
      .splice(0)
      .map((dataDir) =>
        rm(dataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }),
      ),
  );
});

describe('core local control channel', () => {
  // Pipe names and case-insensitive paths only exist on Windows.
  it.runIf(process.platform === 'win32')(
    'derives a stable Windows pipe name from the canonical engine directory',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'ferry-core-pipe-name-'));
      dataDirectories.push(root);
      const first = localControlSocketAddress(join(root, 'Engine'), 'win32');
      const second = localControlSocketAddress(join(root, 'engine'), 'win32');
      expect(first.transport).toBe('pipe');
      expect(second).toEqual(first);
    },
  );

  it('rejects a missing or incorrect authentication token', () => {
    expect(verifyLocalControlToken('expected-token-value', undefined)).toBe(false);
    expect(verifyLocalControlToken('expected-token-value', '')).toBe(false);
    expect(verifyLocalControlToken('expected-token-value', 'wrong-token-value')).toBe(false);
    expect(verifyLocalControlToken('expected-token-value', 'expected-token-value')).toBe(true);
  });

  it('writes a private endpoint descriptor, rejects unauthenticated RPC, and rotates it on restart', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ferry-core-local-control-'));
    dataDirectories.push(dataDir);
    let methodCalls = 0;
    const first = new CoreHost({ dataDir, localControl: true });
    first.registerDomain('settings', {
      get() {
        methodCalls += 1;
        return { theme: 'system' };
      },
    });
    await first.start();
    const endpointPath = localControlEndpointPath(first.dataDir);
    const firstEndpoint = await readLocalControlEndpoint(first.dataDir);
    if (!firstEndpoint) throw new Error('Local endpoint descriptor was not written');
    expect(firstEndpoint.version).toBe(1);
    expect(['pipe', 'unix']).toContain(firstEndpoint.transport);
    expect(firstEndpoint.token.length).toBeGreaterThanOrEqual(32);
    if (process.platform !== 'win32') {
      const permissions = (await stat(endpointPath)).mode & 0o777;
      expect(permissions).toBe(0o600);
      expect((await stat(dataDir)).mode & 0o777).toBe(0o700);
      expect((await stat(firstEndpoint.endpoint)).mode & 0o777).toBe(0o600);
    }

    const endpoint = firstEndpoint.endpoint;
    const missingToken = await sendHandshake(endpoint, { type: 'ferry.local-auth' });
    const wrongToken = await sendHandshake(endpoint, {
      type: 'ferry.local-auth',
      token: 'incorrect-local-control-token',
    });
    const unauthenticatedRpc = await sendHandshake(endpoint, {
      jsonrpc: '2.0',
      id: 1,
      method: 'settings.get',
      params: [],
    });
    expect(missingToken).toMatchObject({ type: 'ferry.local-auth', authenticated: false });
    expect(wrongToken).toMatchObject({ type: 'ferry.local-auth', authenticated: false });
    expect(unauthenticatedRpc).toMatchObject({
      type: 'ferry.local-auth',
      authenticated: false,
    });
    expect(methodCalls).toBe(0);
    await first.stop();
    await expect(readFile(endpointPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    const second = new CoreHost({ dataDir, localControl: true });
    await second.start();
    try {
      const secondEndpoint = await readLocalControlEndpoint(second.dataDir);
      if (!secondEndpoint) throw new Error('Restarted core did not publish its endpoint');
      expect(secondEndpoint.token).not.toBe(firstEndpoint.token);
    } finally {
      await second.stop();
    }
  }, 30_000);

  it('delivers replies larger than 1 MB to an attached client', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ferry-core-local-control-large-'));
    dataDirectories.push(dataDir);
    // Real provider lists carry every discovered model; with OpenRouter they pass 1 MB.
    const big = Array.from({ length: 30_000 }, (_, index) => ({
      ref: `openrouter/vendor/model-${String(index)}`,
      name: `Model ${String(index)} with a reasonably long display name`,
    }));
    const core = new CoreHost({ dataDir, localControl: true });
    core.registerDomain('settings', {
      get() {
        return { models: big };
      },
    });
    await core.start();
    try {
      const transport = await connectLocalControl(core.dataDir);
      try {
        const reply = await new Promise<unknown>((resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new Error('Large reply timed out'));
          }, 15_000);
          transport.subscribe((message) => {
            const value = message as { id?: unknown; result?: unknown };
            if (value.id !== 'large') return;
            clearTimeout(timer);
            resolve(value.result);
          });
          transport.onClose((reason) => {
            clearTimeout(timer);
            reject(reason ?? new Error('closed'));
          });
          transport.send({ jsonrpc: '2.0', id: 'large', method: 'settings.get', params: [] });
        });
        expect(JSON.stringify(reply).length).toBeGreaterThan(2_000_000);
        expect((reply as { models: unknown[] }).models).toHaveLength(30_000);
      } finally {
        transport.close?.();
      }
    } finally {
      await core.stop();
    }
  }, 30_000);

  it('starts the core when endpoint publication fails', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ferry-core-local-control-failure-'));
    dataDirectories.push(dataDir);
    await mkdir(localControlEndpointPath(dataDir));
    await writeFile(join(localControlEndpointPath(dataDir), 'sentinel'), 'block');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const core = new CoreHost({ dataDir, localControl: true });
    try {
      await expect(core.start()).resolves.toBeUndefined();
      await expect(
        core.dispatch({ jsonrpc: '2.0', id: 1, method: 'system.info', params: [] }),
      ).resolves.toMatchObject({ dataDir: core.dataDir, mock: false });
      expect(await readLocalControlEndpoint(dataDir)).toBeUndefined();
      expect(warning).toHaveBeenCalledTimes(1);
    } finally {
      await core.stop();
      warning.mockRestore();
    }
  }, 30_000);
});

async function sendHandshake(endpoint: string, payload: unknown): Promise<unknown> {
  const { createConnection } = await import('node:net');
  const socket = createConnection(endpoint);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => {
        resolve();
      });
      socket.once('error', reject);
    });
    socket.write(`${JSON.stringify(payload)}\n`);
    const line = await new Promise<string>((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(() => {
        reject(new Error('Authentication rejection timed out'));
      }, 5_000);
      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        const newline = buffer.indexOf('\n');
        if (newline >= 0) {
          clearTimeout(timer);
          resolve(buffer.slice(0, newline));
        }
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    return JSON.parse(line) as unknown;
  } finally {
    socket.destroy();
  }
}
