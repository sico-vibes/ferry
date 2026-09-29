import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createServices } from '../packages/core/src/services.ts';
import { CoreHost, createMemoryTransportPair } from '../packages/core/src/index.ts';
import { domainRegistrars } from '../packages/core/src/domains/index.ts';
import { createRpcFerryClient } from '../packages/client/src/index.ts';
import { detectAcpAgents, detectCli } from '../packages/delegate/src/index.ts';

const timeoutMs = Number(process.env.FERRY_LIVE_DELEGATION_TIMEOUT_MS ?? 8 * 60_000);
const timeoutSeconds = Math.max(1, Math.round(timeoutMs / 1000));
const rows = [];
let taskSerial = 0;
const scratchRoot = await mkdtemp(join(tmpdir(), 'ferry-live-delegation-'));
const dataDir = join(scratchRoot, 'data');
const workspacePath = join(scratchRoot, 'fixture-repo');
const configHome = join(scratchRoot, 'config');
let services;
let host;
let rpc;

function command(executable, args, cwd, timeout = 30_000) {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: 'utf8',
    timeout,
    windowsHide: true,
    shell: process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(executable),
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `${executable} failed (${result.status ?? 'spawn'}): ${result.error?.message ?? result.stderr?.slice(-2000) ?? ''}`,
    );
  return result.stdout.trim();
}
function note(agent, version, status, startedAt, files = '-', gates = '-') {
  rows.push({
    agent,
    version: version ?? '-',
    status,
    duration: `${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
    files,
    gates,
  });
}
function repoFiles() {
  const output = command('git', ['status', '--short'], workspacePath);
  return output
    ? output
        .split(/\r?\n/)
        .map((line) => line.slice(3))
        .filter(Boolean)
    : [];
}
async function waitForRun(sessionId, runId) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runs = await rpc.delegation.runs(sessionId);
    const run = runs.find((item) => item.id === runId);
    if (!run) throw new Error(`Delegation run disappeared: ${runId}`);
    if (['completed', 'failed', 'cancelled'].includes(run.status)) return run;
    await delay(500);
  }
  throw new Error(`Delegation run timed out after ${timeoutSeconds}s`);
}
async function runTask(lane, version, options = {}) {
  const startedAt = Date.now();
  taskSerial += 1;
  const testFile = `test/add-${String(taskSerial).padStart(2, '0')}.test.js`;
  const baseline = new Set(repoFiles());
  const workspace = (await rpc.workspaces.list())[0];
  if (!workspace) throw new Error('Scratch workspace was not registered');
  const session = await rpc.sessions.create({
    workspaceId: workspace.id,
    title: `Live delegation ${lane.name}`,
  });
  const brief = [
    'Add a focused unit test for the existing add(left, right) function.',
    `Create ${testFile} using the built-in node:test and node:assert modules.`,
    'The test must verify add(2, 3) is 5 and add(-1, 1) is 0. Do not change src/add.mjs.',
    'Do not commit. Keep the diff limited to the unit test.',
  ].join('\n');
  const initial = await rpc.delegation.start({ sessionId: session.id, lane: lane.name, brief });
  let run = await waitForRun(session.id, initial.id);
  if (run.status !== 'completed') {
    const unauthenticated =
      /not authenticated|authentication required|not logged in|login required|no credentials|api key.+(?:missing|required)/i.test(
        run.finalMessage ?? '',
      );
    note(
      lane.name,
      version,
      unauthenticated ? 'SKIP (not authenticated)' : `FAIL (${run.status})`,
      startedAt,
      run.touchedFiles.join(', ') || '-',
      run.gateResults.map((gate) => `${gate.ok ? 'ok' : 'fail'}:${gate.command}`).join('; ') || '-',
    );
    return { ok: false, skipped: unauthenticated };
  }
  const changed = repoFiles().filter((file) => !baseline.has(file));
  command('git', ['add', '--intent-to-add', '--all'], workspacePath);
  const diff = command('git', ['diff', '--stat'], workspacePath);
  if (
    !changed.length ||
    !diff ||
    !run.gateResults.length ||
    run.gateResults.some((gate) => !gate.ok)
  ) {
    await rpc.delegation.decide(run.id, 'rejected');
    note(
      lane.name,
      version,
      'FAIL (review/gate)',
      startedAt,
      changed.join(', ') || '-',
      run.gateResults.map((gate) => `${gate.ok ? 'ok' : 'fail'}:${gate.command}`).join('; ') ||
        'no gates',
    );
    return { ok: false };
  }
  if (options.reject) {
    await rpc.delegation.decide(run.id, 'rejected');
    const restored = repoFiles().filter((file) => !baseline.has(file));
    note(
      lane.name,
      version,
      restored.length ? 'FAIL (reject restore)' : 'PASS (rejected/restored)',
      startedAt,
      changed.join(', '),
      run.gateResults.map((gate) => `${gate.ok ? 'ok' : 'fail'}:${gate.command}`).join('; '),
    );
    return { ok: restored.length === 0 };
  }
  let reworkGatePassed = null;
  if (options.rework) {
    run = await rpc.delegation.decide(
      run.id,
      'rework',
      `Keep the same session and edit ${testFile}. Add one assertion that add(10, -4) is 6, then report the changed test file.`,
    );
    const gateAfterRework = spawnSync('node', ['--test'], {
      cwd: workspacePath,
      encoding: 'utf8',
      timeout: 120_000,
      windowsHide: true,
    });
    reworkGatePassed = !gateAfterRework.error && gateAfterRework.status === 0;
    if (
      run.status !== 'completed' ||
      gateAfterRework.error ||
      gateAfterRework.status !== 0 ||
      run.gateResults.some((gate) => !gate.ok)
    ) {
      note(
        lane.name,
        version,
        'FAIL (rework)',
        startedAt,
        run.touchedFiles.join(', ') || '-',
        run.gateResults.map((gate) => `${gate.ok ? 'ok' : 'fail'}:${gate.command}`).join('; ') ||
          '-',
      );
      return { ok: false };
    }
  }
  await rpc.delegation.decide(run.id, 'accepted');
  const files = repoFiles().filter((file) => !baseline.has(file));
  const gateOutput = [
    ...run.gateResults.map((gate) => `${gate.ok ? 'ok' : 'fail'}:${gate.command}`),
    ...(reworkGatePassed === null
      ? []
      : [`node --test (rework):${reworkGatePassed ? 'ok' : 'fail'}`]),
  ].join('; ');
  note(
    lane.name,
    version,
    options.rework ? 'PASS (reworked/accepted)' : 'PASS (accepted)',
    startedAt,
    files.join(', ') || '-',
    gateOutput || '-',
  );
  return { ok: true };
}

try {
  await mkdir(join(configHome, 'delegate-skills'), { recursive: true });
  await mkdir(join(workspacePath, 'src'), { recursive: true });
  await mkdir(join(workspacePath, 'test'), { recursive: true });
  await writeFile(
    join(workspacePath, 'package.json'),
    JSON.stringify(
      {
        name: 'ferry-delegation-fixture',
        private: true,
        type: 'module',
        scripts: { test: 'node --test' },
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  await writeFile(
    join(workspacePath, 'src', 'add.mjs'),
    'export function add(left, right) { return left + right; }\n',
    'utf8',
  );
  await writeFile(
    join(workspacePath, 'README.md'),
    '# Ferry delegation fixture\n\nA tiny scratch repository for live delegation checks.\n',
    'utf8',
  );
  command('git', ['init', '-q'], workspacePath);
  command(
    'git',
    [
      '-c',
      'user.name=Ferry Harness',
      '-c',
      'user.email=ferry-harness@example.invalid',
      'add',
      '--all',
    ],
    workspacePath,
  );

  const native = [];
  for (const name of ['codex', 'opencode', 'claude']) {
    try {
      const detection = await detectCli(name, {
        cwd: workspacePath,
        checkAuth: true,
        timeoutMs: 15_000,
      });
      if (detection.available && detection.authenticated)
        native.push({ name, implementer: name, version: detection.version ?? 'unknown' });
      else note(name, detection.version, 'SKIP (not installed/authenticated)', Date.now());
    } catch {
      note(name, null, 'SKIP (not installed/authenticated)', Date.now());
    }
  }
  let acp = [];
  try {
    acp = (await detectAcpAgents({ cwd: workspacePath, timeoutMs: 10_000 }))
      .filter(
        (agent) => agent.available && !['codex', 'opencode', 'claude-code'].includes(agent.id),
      )
      .map((agent) => ({
        name: agent.id,
        implementer: 'acp',
        agent: agent.id,
        transport: 'acp',
        version: agent.version ?? 'unknown',
      }));
  } catch {
    // An unavailable ACP registry adds no runnable lanes.
  }
  const detected = [...native, ...acp];
  if (!detected.length) {
    console.log('No supported delegate is both installed and authenticated; live tasks skipped.');
  } else {
    const laneConfig = {
      version: 'delegate-fleet.v1',
      lanes: Object.fromEntries(
        detected.map((agent) => [
          agent.name,
          {
            implementer: agent.implementer,
            ...(agent.agent ? { agent: agent.agent, transport: 'acp' } : {}),
            permission: 'scoped_write',
            paths: ['.'],
          },
        ]),
      ),
    };
    await writeFile(
      join(configHome, 'delegate-skills', 'config.json'),
      JSON.stringify(laneConfig, null, 2),
      'utf8',
    );
    const env = {
      ...process.env,
      XDG_CONFIG_HOME: configHome,
      FERRY_DEV_MODE: 'true',
      FERRY_GATE_COMMANDS: 'node --test',
    };
    services = await createServices({ dataDir, env });
    const [coreTransport, clientTransport] = createMemoryTransportPair();
    host = new CoreHost({
      dataDir: services.paths.home,
      services,
      transport: coreTransport,
      websocketEnabled: false,
    });
    for (const register of domainRegistrars) register(host, services);
    await host.start();
    rpc = createRpcFerryClient(clientTransport, { timeoutMs: timeoutMs + 15_000 });
    await rpc.hello;
    const workspace = await rpc.workspaces.open(workspacePath);
    await rpc.workspaces.update(workspace.id, {
      gateCommands: ['node --test'],
      permissionMode: 'auto_edit',
    });
    let decisionsExercised = false;
    for (let index = 0; index < detected.length; index += 1) {
      const agent = detected[index];
      if (!agent) continue;
      const result = await runTask(
        {
          name: agent.name,
          implementer: agent.implementer,
          agent: agent.agent ?? null,
          transport: agent.transport ?? 'native',
          permission: 'scoped_write',
          paths: ['.'],
          source: 'global',
          trusted: true,
        },
        agent.version,
        { rework: !decisionsExercised },
      );
      if (!result.ok) {
        if (!result.skipped) process.exitCode = 1;
        continue;
      }
      if (!decisionsExercised) {
        decisionsExercised = true;
        const rejected = await runTask(
          {
            name: agent.name,
            implementer: agent.implementer,
            agent: agent.agent ?? null,
            transport: agent.transport ?? 'native',
            permission: 'scoped_write',
            paths: ['.'],
            source: 'global',
            trusted: true,
          },
          agent.version,
          { reject: true },
        );
        if (!rejected.ok) process.exitCode = 1;
      }
    }
  }
} catch (error) {
  rows.push({
    agent: 'harness',
    version: '-',
    status: `FAIL (${error instanceof Error ? error.message : String(error)})`,
    duration: '-',
    files: '-',
    gates: '-',
  });
  process.exitCode = 1;
} finally {
  await rpc?.close?.().catch(() => undefined);
  await host?.stop().catch(() => undefined);
  await services?.dispose().catch(() => undefined);
  await rm(scratchRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  console.log('\nLive delegation results');
  console.table(rows);
}
