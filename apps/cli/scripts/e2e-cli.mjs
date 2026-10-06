import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeOpenAIServer } from '../../../packages/testkit/src/fake-servers.ts';

const cliDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const cliEntry = join(cliDirectory, 'dist', 'ferry.js');
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'ferry-cli-e2e-'));
const dataDirectory = join(temporaryDirectory, 'engine');
const workspace = join(temporaryDirectory, 'workspace');
const firstModel = 'qwen/qwen3.8-27b:free';
const secondModel = 'openai/gpt-oss-120b';
const fake = new FakeOpenAIServer({
  models: [
    { id: firstModel, supported_parameters: ['tools'] },
    { id: secondModel, supported_parameters: ['tools'] },
  ],
  responses: [],
});

function completion(text) {
  return {
    chunks: [
      {
        id: 'chatcmpl_cli_e2e',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'fake-served-model',
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      },
      {
        id: 'chatcmpl_cli_e2e',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'fake-served-model',
        choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
      },
      {
        id: 'chatcmpl_cli_e2e',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'fake-served-model',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      },
    ],
  };
}

function jsonEvents(stdout) {
  return stdout
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

async function runCli(prompt, extraArgs = []) {
  const child = spawn(
    process.execPath,
    [
      cliEntry,
      'run',
      prompt,
      '--engine',
      'local',
      '--data-dir',
      dataDirectory,
      '--cwd',
      workspace,
      '--permission',
      'full_auto',
      '--max-steps',
      '1',
      '--json',
      ...extraArgs,
    ],
    {
      cwd: workspace,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        FERRY_HOME: dataDirectory,
        FERRY_DATA_DIR: dataDirectory,
        FERRY_E2E_USER_DATA_DIR: dataDirectory,
        FERRY_E2E_PROVIDER_IDS: 'openrouter,groq',
        FERRY_E2E_PROVIDER_KEY: 'fixture-key',
        FERRY_PROVIDER_BASE_URL_OPENROUTER: `${fake.baseUrl}/v1`,
        FERRY_PROVIDER_BASE_URL_GROQ: `${fake.baseUrl}/groq/v1`,
        FERRY_TEST_KEYRING_NAMESPACE: `ferry-cli-e2e-${process.pid}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const timer = setTimeout(() => child.kill(), 60_000);
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(timer));
  assert.equal(result.code, 0, `CLI failed (${String(result.signal)}):\n${stderr}\n${stdout}`);
  return jsonEvents(stdout);
}

function completedRun(events) {
  return events.findLast((event) => event.type === 'run.completed');
}

function deltasContain(events, expected) {
  return events
    .filter((event) => event.type === 'session.delta')
    .some((event) => event.textDelta?.includes(expected));
}

function chatRequests() {
  return fake.requests.filter(
    (request) => request.method === 'POST' && request.url.endsWith('/chat/completions'),
  );
}

function requestedModel(request) {
  return request?.body?.model;
}

try {
  await fake.start();
  await mkdir(workspace, { recursive: true });
  await writeFile(
    join(workspace, 'README.md'),
    'Small fixture workspace for Ferry CLI E2E.\n',
    'utf8',
  );

  fake.setResponses([completion('plain-reply')]);
  const plainRequestStart = chatRequests().length;
  const plainEvents = await runCli('Reply with plain-reply', ['--profile', 'Auto-Free']);
  const plainRun = completedRun(plainEvents);
  const plainRequest = chatRequests().slice(plainRequestStart).at(-1);
  const pinnedModel = firstModel;
  const fallbackModel = secondModel;
  const pinnedModelRef = `openrouter/${pinnedModel}`;
  assert.ok(deltasContain(plainEvents, 'plain-reply'));
  const plainProvider = plainRequest.url.startsWith('/groq/') ? 'groq' : 'openrouter';
  assert.equal(plainRun?.servedModel, `${plainProvider}/${requestedModel(plainRequest)}`);
  assert.ok(plainRun.attempts.some((attempt) => attempt.model === plainRun.servedModel));
  console.log(`PASS plain send; served model ${plainRun.servedModel}`);

  fake.setResponses([completion('pinned-reply')]);
  const pinnedRequestStart = chatRequests().length;
  const pinnedEvents = await runCli('Reply with pinned-reply', ['--model-ref', pinnedModelRef]);
  const pinnedRun = completedRun(pinnedEvents);
  assert.equal(pinnedRun?.servedModel, pinnedModelRef, JSON.stringify(pinnedEvents));
  assert.equal(requestedModel(chatRequests().slice(pinnedRequestStart).at(-1)), pinnedModel);
  console.log(`PASS pinned model requested: ${pinnedModel}`);

  fake.setResponses([completion('direct-profile-reply')]);
  const directEvents = await runCli('Reply with direct-profile-reply', [
    '--profile',
    'No profile',
    '--model-ref',
    pinnedModelRef,
  ]);
  const directRun = completedRun(directEvents);
  assert.equal(directRun?.servedModel, pinnedModelRef);
  assert.ok(deltasContain(directEvents, 'direct-profile-reply'));
  console.log('PASS No profile run');

  const chain = spawnSync(process.execPath, [
    cliEntry,
    'profiles',
    'chain',
    'set',
    'Auto-Free',
    `openrouter=${pinnedModel}`,
    `groq=${secondModel}`,
    '--json',
    '--data-dir',
    dataDirectory,
  ]);
  assert.equal(chain.status, 0, chain.stderr.toString());
  console.log(`Configured failover chain: ${chain.stdout.toString().trim()}`);
  fake.setResponses([{ status: 429 }, completion('failover-reply')]);
  const failoverEvents = await runCli('Reply after a rate limit', ['--profile', 'Auto-Free']);
  assert.ok(deltasContain(failoverEvents, 'failover-reply'));
  const attempts = completedRun(failoverEvents)?.attempts ?? [];
  const failedModelAttempt = attempts.find((attempt) => attempt.status === 429);
  const successfulModelAttempt = attempts.find((attempt) => attempt.status === 200);
  assert.ok(failedModelAttempt?.model.endsWith(`/${pinnedModel}`), JSON.stringify(attempts));
  assert.ok(successfulModelAttempt?.model === `groq/${secondModel}`, JSON.stringify(attempts));
  console.log(
    `PASS failover attempts: ${attempts.map((attempt) => `${attempt.model} ${String(attempt.status)}`).join(' → ')}`,
  );

  const manyFiles = join(workspace, 'many-files');
  await mkdir(manyFiles, { recursive: true });
  for (let start = 0; start < 20_000; start += 500) {
    await Promise.all(
      Array.from({ length: Math.min(500, 20_000 - start) }, (_, offset) => {
        const index = start + offset;
        return writeFile(
          join(manyFiles, `file-${String(index)}.txt`),
          `fixture ${String(index)}\n`,
        );
      }),
    );
  }
  fake.setResponses([completion('many-files-reply')]);
  const manyFilesStart = Date.now();
  const manyFilesEvents = await runCli('Reply from the many-file workspace');
  const manyFilesElapsed = Date.now() - manyFilesStart;
  assert.ok(deltasContain(manyFilesEvents, 'many-files-reply'));
  assert.ok(
    manyFilesElapsed < 5_000,
    `CLI did not start a run within five seconds in a 20k-file workspace (${String(manyFilesElapsed)} ms)`,
  );
  console.log(`PASS many-file workspace started and replied in ${String(manyFilesElapsed)} ms`);
} finally {
  await fake.stop();
  await rm(temporaryDirectory, {
    recursive: true,
    force: true,
    maxRetries: 8,
    retryDelay: 100,
  });
}
