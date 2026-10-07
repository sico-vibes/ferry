import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createUpdaterLogger } from './updater-log.js';
import { gatewayBelongsToInstall } from './update-gateway.js';

it('caps the update log and rotates a single backup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ferry-updater-log-'));
  try {
    const file = join(root, 'logs', 'updater.log');
    const logger = createUpdaterLogger(file, 200);
    for (let index = 0; index < 10; index++) logger.info('update', 'x'.repeat(80));
    expect((await stat(file)).size).toBeLessThanOrEqual(200);
    expect((await stat(`${file}.1`)).size).toBeLessThanOrEqual(200);
    expect(await readFile(file, 'utf8')).toContain('INFO update');
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

it('only stops Gateway processes belonging to this installed CLI', () => {
  const install = join(tmpdir(), 'Ferry');
  const executable = join(install, 'Ferry.exe');
  const commandLine = `"${executable}" "${join(install, 'resources', 'cli', 'ferry.js')}" serve --gateway`;
  expect(gatewayBelongsToInstall({ executable, commandLine }, install)).toBe(true);
  expect(
    gatewayBelongsToInstall(
      { executable: join(tmpdir(), 'other', 'Ferry.exe'), commandLine },
      install,
    ),
  ).toBe(false);
  expect(gatewayBelongsToInstall({ executable, commandLine: 'unrelated.js' }, install)).toBe(false);
});
