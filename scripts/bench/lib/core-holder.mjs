// Existing workspace tsx loads the public core entry; no source changes or extra
// dependencies. Keep a real core alive for CLI local-control attachment tests.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { root } from './options.mjs';

const requireCli = createRequire(join(root, 'apps/cli/package.json'));
const { createCoreHost, createMemoryTransportPair } = await import(
  pathToFileURL(requireCli.resolve('@ferry/core')).href
);
const [transport] = createMemoryTransportPair();
const host = await createCoreHost({ dataDir: process.argv[2], transport, localControl: true });
const timer = setInterval(() => {}, 60_000);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, async () => {
    clearInterval(timer);
    await host.stop();
  });
