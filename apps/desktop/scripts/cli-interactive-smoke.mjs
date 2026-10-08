import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeOpenAIServer } from '../../../packages/testkit/src/fake-servers.ts';

if (process.platform !== 'win32')
  throw new Error('Interactive installed CLI smoke requires Windows.');
const desktopRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = resolve(desktopRoot, '../..');
const cli = process.env.FERRY_SMOKE_CLI;
const executable = process.env.FERRY_SMOKE_EXECUTABLE;
const dataDirectory = process.env.FERRY_SMOKE_DATA_DIR;
if (!cli || !executable || !dataDirectory)
  throw new Error(
    'FERRY_SMOKE_CLI, FERRY_SMOKE_EXECUTABLE, and FERRY_SMOKE_DATA_DIR are required.',
  );
const require = createRequire(join(root, 'apps/cli/package.json'));
const pty = require('node-pty');
const model = 'qwen/qwen3.8-27b:free';
const response = {
  chunks: [
    {
      id: 'chatcmpl_smoke',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'fake-served-model',
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    },
    {
      id: 'chatcmpl_smoke',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'fake-served-model',
      choices: [
        {
          index: 0,
          delta: { content: 'scripted reply\n\n```ts\nconst bundledHighlight = 42;\n```' },
          finish_reason: null,
        },
      ],
    },
    {
      id: 'chatcmpl_smoke',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'fake-served-model',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    },
  ],
};
const fake = new FakeOpenAIServer({
  models: [{ id: model, supported_parameters: ['tools'] }],
  responses: [response, response],
});
await fake.start();
const environment = {
  ...process.env,
  ELECTRON_RUN_AS_NODE: '1',
  FERRY_SMOKE_EXECUTABLE: executable,
  FERRY_E2E_USER_DATA_DIR: dataDirectory,
  FERRY_E2E_PROVIDER_IDS: 'openrouter',
  FERRY_E2E_PROVIDER_KEY: 'fixture-key',
  FERRY_PROVIDER_BASE_URL_OPENROUTER: `${fake.baseUrl}/v1`,
  FERRY_TEST_KEYRING_NAMESPACE: `ferry-installed-cli-${process.pid}`,
  NODE_ENV: 'test',
  // CI runners set this, and Ink then stops drawing unless the CLI forces interactive mode.
  CI: 'true',
};
// Console diagnostics from the same runtime and launch path, printed first so a failure on another
// Windows version shows what the bundled runtime could see.
await new Promise((resolveDiag) => {
  const diagScript = join(desktopRoot, 'scripts', 'tty-diag.cjs');
  let diag = '';
  const probe = pty.spawn(
    process.env.ComSpec ?? 'cmd.exe',
    `/d /s /c "set ELECTRON_RUN_AS_NODE=1&& "${executable}" "${diagScript}""`,
    { cwd: tmpdir(), env: process.env, cols: 100, rows: 20, useConpty: true },
  );
  const done = () => {
    const line = diag.split(/\r?\n/).find((entry) => entry.includes('FERRY_TTY_DIAG'));
    console.log(line ? line.trim() : `FERRY_TTY_DIAG unavailable: ${diag.slice(-300)}`);
    resolveDiag();
  };
  probe.onData((data) => (diag += data));
  probe.onExit(done);
  setTimeout(() => {
    probe.kill();
    done();
  }, 20_000);
});

try {
  for (const variant of ['cmd', 'pwsh']) {
    const workspace = await mkdtemp(join(tmpdir(), `ferry-pty-${variant}-`));
    const variantDataDirectory = join(dataDirectory, variant);
    const variantEnvironment = {
      ...environment,
      FERRY_DATA_DIR: join(variantDataDirectory, 'engine'),
      FERRY_E2E_USER_DATA_DIR: variantDataDirectory,
    };
    let output = '';
    let child;
    try {
      // Both shells run the installed wrapper inside ConPTY, matching interactive user launch.
      const command =
        variant === 'cmd'
          ? `/d /s /c ""${cli}" --data-dir "${join(variantDataDirectory, 'engine')}" --cwd "${workspace}""`
          : `& '${cli.replaceAll("'", "''")}' --data-dir '${join(variantDataDirectory, 'engine').replaceAll("'", "''")}' --cwd '${workspace.replaceAll("'", "''")}'`;
      child = pty.spawn(
        variant === 'cmd' ? (process.env.ComSpec ?? 'cmd.exe') : 'pwsh.exe',
        variant === 'cmd' ? command : ['-NoLogo', '-Command', command],
        {
          cwd: workspace,
          env: variantEnvironment,
          cols: 100,
          rows: 30,
          name: 'xterm-color',
          useConpty: true,
        },
      );
      child.onData((data) => (output += data));
      // Subscribe before navigation: a fast exit must not be lost while waiting for cmd's prompt.
      const exited = new Promise((resolveExit) => child.onExit(resolveExit));
      const waitFor = async (value, timeout = 30_000) => {
        const deadline = Date.now() + timeout;
        while (!output.includes(value) && Date.now() < deadline)
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 40));
        assert.ok(
          output.includes(value),
          `${variant}: timed out waiting for ${value}. Terminal output:\n${output}`,
        );
      };
      await waitFor('Trust ');
      child.write('y\r');
      // First render waits for the engine to start in a fresh data folder; CI runners are slower.
      await waitFor('›', 120_000);
      child.write('/model\r');
      await waitFor('options · ↑/↓ navigate');
      // Auto and No profile precede the one verified fake model.
      child.write('\x1b[B');
      await waitFor('› No profile');
      child.write('\x1b[B');
      await waitFor('› Qwen3.8 27B');
      child.write('\r');
      await waitFor(`Model set to openrouter/${model}`);
      child.write('hello\r');
      await waitFor('scripted reply', 60_000);
      await waitFor('bundledHighlight', 15_000);
      assert.ok(!output.includes('ERROR'), `${variant}: markdown rendering failed:\n${output}`);
      // The CLI labels each reply with the Ferry model that served it.
      await waitFor(`via openrouter/${model}`, 15_000);
      const previousOutput = output;
      output = '';
      child.write('/sessions\r');
      await waitFor('Filter: type to search');
      assert.match(
        output,
        /hello/i,
        `${variant}: sessions picker did not list the chat:\n${output}`,
      );
      const sessionOutput = output;
      output = '';
      child.write('\x1b');
      await waitFor('Enter sends');
      output = previousOutput + sessionOutput + output;
      child.write('\x03');
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
      child.write('\x03');
      // cmd.exe asks this after Ctrl+C in any .cmd launcher (npm shims do the same); answer it so
      // the batch finishes with Ferry's own exit code.
      const batchPrompt = Date.now() + 5_000;
      while (!output.includes('Terminate batch job') && Date.now() < batchPrompt)
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 40));
      if (output.includes('Terminate batch job')) child.write('N\r');
      const exitCode = await new Promise((resolvePromise, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              new Error(
                `${variant}: CLI did not exit after Ctrl+C twice. Last output:
${output.slice(-1500)}`,
              ),
            ),
          10_000,
        );
        void exited.then(({ exitCode: code }) => {
          clearTimeout(timer);
          resolvePromise(code);
        });
      });
      // Under the bundled runtime a console Ctrl+C can end the process directly; Windows then reports
      // STATUS_CONTROL_C_EXIT (0xC000013A). Both that and a clean 0 mean the user's Ctrl+C exited.
      const CONTROL_C_EXIT = -1073741510;
      assert.ok(
        exitCode === 0 ||
          exitCode === CONTROL_C_EXIT ||
          exitCode === 0xc000013a ||
          // pwsh -Command reports a native command ended by Ctrl+C as a plain failure (1).
          (variant === 'pwsh' && exitCode === 1),
        `${variant}: CLI exited with code ${exitCode}.`,
      );
    } finally {
      if (child) child.kill();
      await rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  }
  console.log(
    'PASS installed-style interactive CLI picks a verified model with arrows, renders a code-block reply and its model, lists the chat in /sessions, and exits on Ctrl+C twice (cmd and pwsh).',
  );
} finally {
  await fake.stop();
}
