import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const appDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const userDataDirectory = await mkdtemp(`${tmpdir()}/ferry-electron-e2e-`);
const electronBinary = createRequire(import.meta.url)('electron');
const application = spawn(
  electronBinary,
  ['--disable-gpu', '--in-process-gpu', '--use-gl=swiftshader', appDirectory],
  {
    cwd: appDirectory,
    env: {
      ...process.env,
      FERRY_E2E_USER_DATA_DIR: userDataDirectory,
      FERRY_E2E_CORE_ONLY: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);

let output = '';
let resolveReady;
let rejectReady;
const ready = new Promise((resolve, reject) => {
  resolveReady = resolve;
  rejectReady = reject;
});
const exit = new Promise((resolve) => application.once('exit', resolve));
const timeout = setTimeout(
  () => rejectReady(new Error(`Timed out waiting for Ferry Core startup: ${output}`)),
  30_000,
);
const capture = (chunk) => {
  output += chunk.toString();
  const match = output.match(/FERRY_CORE_READY (.+)/);
  if (match) resolveReady(JSON.parse(match[1]));
};
application.stdout.on('data', capture);
application.stderr.on('data', capture);
application.once('error', rejectReady);
application.once('exit', (code) => {
  if (code !== 0) rejectReady(new Error(`Ferry exited with ${code}: ${output}`));
});

try {
  const selfTest = await ready;
  clearTimeout(timeout);
  assert.deepEqual(
    selfTest.modules.map(({ name }) => name),
    ['better-sqlite3', 'node-pty', '@napi-rs/keyring'],
  );
  assert.ok(
    selfTest.modules.every((module) => module.ok),
    `Electron core native selfTest failed: ${JSON.stringify(selfTest)}`,
  );
  console.log(`Electron core connected; native selfTest: ${JSON.stringify(selfTest)}`);
} finally {
  clearTimeout(timeout);
  application.kill();
  await Promise.race([exit, new Promise((resolve) => setTimeout(resolve, 15_000))]);
  await rm(userDataDirectory, { recursive: true, force: true }).catch(() => undefined);
}
