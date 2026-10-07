import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
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
let gatewayServer;

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
  const result = await runCliResult(prompt, extraArgs);
  assert.equal(
    result.code,
    0,
    `CLI failed (${String(result.signal)}):\n${result.stderr}\n${result.stdout}`,
  );
  return jsonEvents(result.stdout);
}

async function runCliResult(prompt, extraArgs = []) {
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
  return { ...result, stdout, stderr };
}

async function runGatewayCli(args, { json = true } = {}) {
  const child = spawn(
    process.execPath,
    [
      cliEntry,
      ...args,
      '--engine',
      'local',
      '--data-dir',
      dataDirectory,
      ...(json ? ['--json'] : []),
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
  const timer = setTimeout(() => child.kill(), 15_000);
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(timer));
  if (result.signal) {
    stderr += `Gateway CLI subprocess was terminated by ${result.signal}.`;
  }
  return { ...result, stdout, stderr };
}

async function startGatewayServer() {
  const child = spawn(
    process.execPath,
    [cliEntry, 'serve', '--gateway', '--data-dir', dataDirectory, '--json'],
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
  gatewayServer = child;
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const line = stdout.split(/\r?\n/).find((entry) => entry.trim());
    if (line) {
      const status = JSON.parse(line);
      assert.ok(status.url, line);
      return status;
    }
    if (child.exitCode !== null)
      throw new Error(`Gateway server exited (${String(child.exitCode)}): ${stderr}\n${stdout}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.kill();
  throw new Error(`Gateway server did not become ready: ${stderr}\n${stdout}`);
}

async function stopGatewayServer() {
  const child = gatewayServer;
  gatewayServer = undefined;
  if (!child || child.exitCode !== null) return;
  child.kill();
  await new Promise((resolve) => child.once('exit', resolve));
}

function resultJson(result) {
  const line = result.stdout.split(/\r?\n/).find((entry) => entry.trim());
  return line ? JSON.parse(line) : undefined;
}

async function gatewayRequests() {
  const endpoint = JSON.parse(await readFile(join(dataDirectory, 'core.endpoint.json'), 'utf8'));
  const socket = createConnection(endpoint.endpoint);
  socket.setEncoding('utf8');
  return await new Promise((resolve, reject) => {
    let input = '';
    let authenticated = false;
    const finish = (error, value) => {
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    socket.once('error', (error) => finish(error));
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ type: 'ferry.local-auth', token: endpoint.token })}\n`);
    });
    socket.on('data', (chunk) => {
      input += chunk;
      const newline = input.indexOf('\n');
      if (newline < 0) return;
      const response = JSON.parse(input.slice(0, newline));
      input = input.slice(newline + 1);
      if (!authenticated) {
        assert.equal(response.authenticated, true, JSON.stringify(response));
        authenticated = true;
        socket.write(
          `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'gateway.requests', params: [] })}\n`,
        );
        return;
      }
      if (response.error) finish(new Error(response.error.message));
      else finish(undefined, response.result);
    });
  });
}

async function createGatewayKey(name, profile, allowedModels) {
  const created = await runGatewayCli([
    'gateway',
    'keys',
    'create',
    name,
    profile,
    ...(allowedModels ? ['--allowed-models', allowedModels.join(',')] : []),
  ]);
  assert.equal(created.code, 0, `${created.stderr}\n${created.stdout}`);
  const key = resultJson(created).key;
  assert.ok(key?.id, created.stdout);
  return key;
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
  await mkdir(workspace, { recursive: true });
  await writeFile(
    join(workspace, 'README.md'),
    'Small fixture workspace for Ferry CLI E2E.\n',
    'utf8',
  );

  await fake.start();
  await startGatewayServer();
  const gatewayModelRef = `groq/${secondModel}`;
  const noProfileKey = await createGatewayKey('CLI no-profile E2E', 'none', [gatewayModelRef]);
  assert.deepEqual(noProfileKey.allowedModels, [gatewayModelRef]);
  const profileKey = await createGatewayKey('CLI profile E2E', 'auto-free', [gatewayModelRef]);

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

  fake.setResponses([completion('gateway-no-profile-reply')]);
  const noProfileRequestStart = chatRequests().length;
  const noProfileEvents = await runCli('Reply with gateway-no-profile-reply', [
    '--profile',
    'No profile',
    '--model-ref',
    `gateway/${noProfileKey.id}`,
  ]);
  const noProfileRequest = chatRequests().slice(noProfileRequestStart);
  assert.equal(noProfileRequest.length, 1, JSON.stringify(noProfileRequest));
  const noProfileGatewayLog = await gatewayRequests();
  assert.equal(requestedModel(noProfileRequest[0]), secondModel);
  assert.ok(deltasContain(noProfileEvents, 'gateway-no-profile-reply'));
  const noProfileRun = completedRun(noProfileEvents);
  assert.equal(noProfileRun?.servedModel, gatewayModelRef);
  const noProfileMessage = noProfileEvents
    .filter((event) => event.type === 'session.message')
    .flatMap((event) => event.messages ?? (event.message ? [event.message] : []))
    .findLast((message) => message.role === 'assistant');
  assert.equal(noProfileMessage?.via?.kind, 'gateway');
  assert.equal(noProfileMessage?.via?.keyId, noProfileKey.id);
  assert.equal(noProfileMessage?.via?.keyName, noProfileKey.name);
  const requests = noProfileGatewayLog;
  assert.equal(requests.filter((request) => request.keyId === noProfileKey.id).length, 1);
  assert.equal(
    requests.find((request) => request.keyId === noProfileKey.id)?.requestedModel,
    gatewayModelRef,
  );
  console.log(`PASS gateway no-profile key chat; served model ${gatewayModelRef}`);

  fake.setResponses([completion('gateway-profile-reply')]);
  const profileRequestStart = chatRequests().length;
  const profileEvents = await runCli('Reply with gateway-profile-reply', [
    '--profile',
    'No profile',
    '--model-ref',
    `gateway/${profileKey.id}`,
  ]);
  const profileRequest = chatRequests().slice(profileRequestStart);
  assert.equal(profileRequest.length, 1, JSON.stringify(profileRequest));
  assert.ok(deltasContain(profileEvents, 'gateway-profile-reply'));
  assert.equal(completedRun(profileEvents)?.servedModel, gatewayModelRef);
  const profileMessage = profileEvents
    .filter((event) => event.type === 'session.message')
    .flatMap((event) => event.messages ?? (event.message ? [event.message] : []))
    .findLast((message) => message.role === 'assistant');
  assert.equal(profileMessage?.via?.kind, 'gateway');
  assert.equal(profileMessage?.via?.keyId, profileKey.id);
  console.log(
    `PASS gateway profile key chat; requested model ${requestedModel(profileRequest[0])}`,
  );

  await stopGatewayServer();
  const callsBeforeStoppedRun = chatRequests().length;
  const stoppedRun = await runCliResult('Must fail with gateway_not_running', [
    '--profile',
    'No profile',
    '--model-ref',
    `gateway/${noProfileKey.id}`,
  ]);
  assert.notEqual(stoppedRun.code, 0, `${stoppedRun.stdout}\n${stoppedRun.stderr}`);
  assert.match(
    `${stoppedRun.stdout}\n${stoppedRun.stderr}`,
    /gateway_not_running|Start the local Gateway/i,
  );
  assert.equal(chatRequests().length, callsBeforeStoppedRun);
  console.log('PASS gateway not running returns gateway_not_running without upstream request');

  await startGatewayServer();
  const revokeResult = await runGatewayCli(['gateway', 'keys', 'revoke', noProfileKey.id]);
  assert.equal(revokeResult.code, 0, `${revokeResult.stderr}\n${revokeResult.stdout}`);
  const revokedRun = await runCliResult('Must fail with revoked gateway key', [
    '--profile',
    'No profile',
    '--model-ref',
    `gateway/${noProfileKey.id}`,
  ]);
  assert.notEqual(revokedRun.code, 0, `${revokedRun.stdout}\n${revokedRun.stderr}`);
  assert.match(`${revokedRun.stdout}\n${revokedRun.stderr}`, /Unknown or revoked Gateway key/i);
  console.log('PASS revoked gateway key is rejected clearly');

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
  const manyFilesEvents = await runCli('Reply from the many-file workspace', [
    '--profile',
    'Auto-Free',
  ]);
  const manyFilesElapsed = Date.now() - manyFilesStart;
  assert.ok(deltasContain(manyFilesEvents, 'many-files-reply'));
  assert.ok(
    manyFilesElapsed < 5_000,
    `CLI did not start a run within five seconds in a 20k-file workspace (${String(manyFilesElapsed)} ms)`,
  );
  console.log(`PASS many-file workspace started and replied in ${String(manyFilesElapsed)} ms`);
} finally {
  await stopGatewayServer();
  await fake.stop();
  await rm(temporaryDirectory, {
    recursive: true,
    force: true,
    maxRetries: 8,
    retryDelay: 100,
  });
}
