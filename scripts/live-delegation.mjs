import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createServices } from '../packages/core/src/services.ts';
import { CoreHost, createMemoryTransportPair } from '../packages/core/src/index.ts';
import { domainRegistrars } from '../packages/core/src/domains/index.ts';
import { createRpcFerryClient } from '../packages/client/src/index.ts';
import { detectAcpAgents, detectCli } from '../packages/delegate/src/index.ts';

const timeoutMs = Number(process.env.FERRY_LIVE_DELEGATION_TIMEOUT_MS ?? 8 * 60_000);
const timeoutSeconds = Math.max(1, Math.round(timeoutMs / 1000));
const rows = [];
const details = [];
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
function redact(value) {
  let text = String(value ?? '');
  for (const path of [process.env.USERPROFILE, scratchRoot])
    if (path) text = text.split(path).join(path === scratchRoot ? '<fixture>' : '<user-home>');
  return text
    .replace(/Bearer\s+[^\s"'`]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|rk|pk|ghp|gho|github_pat)-[A-Za-z0-9_-]{8,}\b/gi, '[REDACTED]')
    .replace(
      /(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password)["']?\s*[:=]\s*["']?)[^"'`\s,}]+/gi,
      '$1[REDACTED]',
    );
}
function delegateSessionId(run) {
  for (const entry of [...(run?.progress ?? [])].reverse()) {
    try {
      const event = JSON.parse(entry.text);
      for (const key of ['sessionID', 'session_id', 'thread_id'])
        if (typeof event?.[key] === 'string') return event[key];
    } catch {
      const match = /(?:sessionID|session_id|thread_id)["']?\s*[:=]\s*["']([^"']+)/i.exec(
        entry.text,
      );
      if (match?.[1]) return match[1];
    }
  }
  const reported = run?.progress
    .map(({ text }) => text)
    .reverse()
    .find((text) => /delegate session id:/i.test(text));
  return reported?.match(/delegate session id:\s*(\S+)/i)?.[1] ?? '-';
}
function recordDetails(agent, ferrySessionId, run, error = null, model = '-') {
  const progress = (run?.progress ?? []).map(({ text }) => text);
  let observedModel = null;
  for (const line of progress) {
    if (!line.startsWith('[OpenCode JSON] ')) continue;
    try {
      const event = JSON.parse(line.slice('[OpenCode JSON] '.length));
      if (typeof event.providerID === 'string' && typeof event.modelID === 'string')
        observedModel = `${event.providerID}/${event.modelID}`;
      else if (typeof event.modelID === 'string') observedModel = event.modelID;
    } catch {
      // Ignore diagnostic events that were truncated before persistence.
    }
  }
  const stderr =
    progress.filter((line) => line.startsWith('[CLI stderr tail]')).at(-1) ??
    (run?.status === 'failed' ? (run.finalMessage ?? '-') : '-');
  details.push({
    agent,
    model: observedModel ? `${model} -> ${observedModel}` : model,
    finalMessage: redact(run?.finalMessage ?? '-').slice(-1_200),
    ferrySessionId: ferrySessionId ?? '-',
    delegateSessionId: delegateSessionId(run),
    progressTail: redact(
      progress
        .filter((line) => !line.startsWith('[CLI stderr tail]'))
        .slice(-8)
        .join('\n') || '-',
    ).slice(-1800),
    openCodeEventsTail: redact(
      progress
        .filter((line) => line.startsWith('[OpenCode JSON] '))
        .slice(-12)
        .join('\n') || '-',
    ).slice(-3_000),
    stderrTail: redact(stderr).slice(-1200),
    error: redact(
      [error, run?.status === 'failed' ? run.finalMessage : null].filter(Boolean).join('\n') || '-',
    ).slice(-1200),
  });
}
function repoFiles() {
  const output = command('git', ['status', '--short', '--untracked-files=all'], workspacePath);
  return output
    ? output
        .split(/\r?\n/)
        .map((line) => line.slice(3))
        .filter(Boolean)
    : [];
}
async function waitForRun(sessionId, runId) {
  const deadline = Date.now() + timeoutMs;
  let completedWithoutGatesAt = null;
  while (Date.now() < deadline) {
    const runs = await rpc.delegation.runs(sessionId);
    const run = runs.find((item) => item.id === runId);
    if (!run) throw new Error(`Delegation run disappeared: ${runId}`);
    if (run.status === 'failed' || run.status === 'cancelled') return run;
    if (run.status === 'completed') {
      if (run.gateResults.length) return run;
      completedWithoutGatesAt ??= Date.now();
      if (Date.now() - completedWithoutGatesAt >= 10_000) return run;
    }
    await delay(250);
  }
  throw new Error(`Delegation run timed out after ${timeoutSeconds}s`);
}
async function runTask(lane, version, options = {}) {
  const startedAt = Date.now();
  taskSerial += 1;
  const testFile = `test/add-${String(taskSerial).padStart(2, '0')}.test.js`;
  const baseline = new Set(repoFiles());
  const workspace = (await rpc.workspaces.list()).find(
    (item) => resolve(item.path) === resolve(workspacePath),
  );
  if (!workspace) throw new Error('Scratch workspace was not registered at the fixture path');
  if (!workspace.settings.gateCommands.includes('node --test'))
    throw new Error('Approved node --test workspace gate was not saved');
  const session = await rpc.sessions.create({
    workspaceId: workspace.id,
    title: `Live delegation ${lane.name}`,
  });
  const brief = [
    'Add a focused unit test for the existing add(left, right) function.',
    `Create ${testFile} using the built-in node:test and node:assert modules.`,
    'The test must verify add(2, 3) is 5 and add(-1, 1) is 0. Do not change src/add.mjs.',
    'Do not commit. Keep the diff limited to the unit test.',
    '## Gates\n- node --test',
  ].join('\n');
  const initial = await rpc.delegation.start({ sessionId: session.id, lane: lane.name, brief });
  let run = await waitForRun(session.id, initial.id);
  if (run.status !== 'completed') {
    await rpc.delegation.decide(run.id, 'rejected').catch(() => undefined);
    const unauthenticated =
      /not authenticated|authentication required|not logged in|login required|no credentials|api key.+(?:missing|required)/i.test(
        run.finalMessage ?? '',
      );
    note(
      lane.name,
      version,
      unauthenticated ? 'SKIP (not authenticated)' : `FAIL (${run.status})`,
      startedAt,
      run.touchedFiles.map((file) => file.path).join(', ') || '-',
      run.gateResults.map((gate) => `${gate.ok ? 'ok' : 'fail'}:${gate.command}`).join('; ') || '-',
    );
    recordDetails(
      lane.name,
      session.id,
      run,
      unauthenticated ? 'Authentication unavailable' : null,
      lane.model ?? (lane.implementer === 'opencode' ? 'OpenCode CLI default' : '-'),
    );
    return { ok: false, skipped: unauthenticated };
  }
  const changed = repoFiles().filter((file) => !baseline.has(file));
  if (!changed.length || !run.gateResults.length || run.gateResults.some((gate) => !gate.ok)) {
    await rpc.delegation.decide(run.id, 'rejected');
    const error = !changed.length
      ? 'Delegate completed without changing files'
      : !run.gateResults.length
        ? 'No approved gates ran'
        : 'A review gate failed';
    note(
      lane.name,
      version,
      'FAIL (review/gate)',
      startedAt,
      changed.join(', ') || '-',
      run.gateResults.map((gate) => `${gate.ok ? 'ok' : 'fail'}:${gate.command}`).join('; ') ||
        'no gates',
    );
    recordDetails(
      lane.name,
      session.id,
      run,
      error,
      lane.model ?? (lane.implementer === 'opencode' ? 'OpenCode CLI default' : '-'),
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
    recordDetails(
      lane.name,
      session.id,
      run,
      restored.length ? 'Reject left changes in the fixture' : null,
      lane.model ?? (lane.implementer === 'opencode' ? 'OpenCode CLI default' : '-'),
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
    reworkGatePassed = run.gateResults.length > 0 && run.gateResults.every((gate) => gate.ok);
    if (run.status !== 'completed' || !reworkGatePassed) {
      await rpc.delegation.decide(run.id, 'rejected').catch(() => undefined);
      note(
        lane.name,
        version,
        'FAIL (rework)',
        startedAt,
        run.touchedFiles.map((file) => file.path).join(', ') || '-',
        run.gateResults.map((gate) => `${gate.ok ? 'ok' : 'fail'}:${gate.command}`).join('; ') ||
          'no gates',
      );
      recordDetails(
        lane.name,
        session.id,
        run,
        'Rework did not complete with passing gates',
        lane.model ?? (lane.implementer === 'opencode' ? 'OpenCode CLI default' : '-'),
      );
      return { ok: false };
    }
  }
  await rpc.delegation.decide(run.id, 'accepted');
  const files = repoFiles().filter((file) => !baseline.has(file));
  const gateOutput = run.gateResults
    .map((gate) => `${gate.ok ? 'ok' : 'fail'}:${gate.command}`)
    .join('; ');
  note(
    lane.name,
    version,
    options.rework ? 'PASS (reworked/accepted)' : 'PASS (accepted)',
    startedAt,
    files.join(', ') || '-',
    gateOutput || '-',
  );
  recordDetails(
    lane.name,
    session.id,
    run,
    null,
    lane.model ?? (lane.implementer === 'opencode' ? 'OpenCode CLI default' : '-'),
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
      if (detection.available && detection.authenticated) {
        native.push({
          name,
          implementer: name,
          version: detection.version ?? 'unknown',
          model: null,
        });
      } else {
        note(name, detection.version, 'SKIP (not installed/authenticated)', Date.now());
        recordDetails(name, null, null, 'CLI is unavailable or not authenticated');
      }
    } catch (error) {
      note(name, null, 'SKIP (not installed/authenticated)', Date.now());
      recordDetails(
        name,
        null,
        null,
        error instanceof Error ? error.message : 'CLI detection failed',
      );
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
            ...(agent.model ? { model: agent.model } : {}),
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
    const resolvedLanes = await rpc.delegation.lanes();
    for (const agent of detected) {
      const resolved = resolvedLanes.find((candidate) => candidate.name === agent.name);
      if (typeof resolved?.model === 'string' && resolved.model.trim())
        agent.model = resolved.model;
    }
    let reworkExercised = false;
    let rejectExercised = false;
    for (const agent of detected) {
      if (agent.implementer === 'opencode' && !agent.model) {
        const skippedAt = Date.now();
        note(agent.name, agent.version, 'SKIP (no OpenCode model configured)', skippedAt);
        recordDetails(
          agent.name,
          null,
          null,
          'Choose a model for OpenCode in Settings > Delegation or set a default in OpenCode config.',
          '-',
        );
        continue;
      }
      const lane = {
        name: agent.name,
        implementer: agent.implementer,
        agent: agent.agent ?? null,
        transport: agent.transport ?? 'native',
        model: agent.model ?? null,
        permission: 'scoped_write',
        paths: ['.'],
        source: 'global',
        trusted: true,
      };
      let primary = null;
      const primaryStartedAt = Date.now();
      try {
        primary = await runTask(lane, agent.version, { rework: !reworkExercised });
        if (primary.ok && !reworkExercised) reworkExercised = true;
        if (!primary.ok && !primary.skipped) process.exitCode = 1;
      } catch (error) {
        note(
          agent.name,
          agent.version,
          `FAIL (${redact(error instanceof Error ? error.message : error)})`,
          primaryStartedAt,
        );
        recordDetails(
          agent.name,
          null,
          null,
          error instanceof Error ? error.message : String(error),
          lane.model ?? (lane.implementer === 'opencode' ? 'OpenCode CLI default' : '-'),
        );
        process.exitCode = 1;
      }
      if (!rejectExercised && !primary?.skipped) {
        const rejectStartedAt = Date.now();
        try {
          const rejected = await runTask(lane, agent.version, { reject: true });
          if (rejected.ok) rejectExercised = true;
          else if (!rejected.skipped) process.exitCode = 1;
        } catch (error) {
          note(
            agent.name,
            agent.version,
            `FAIL (reject: ${redact(error instanceof Error ? error.message : error)})`,
            rejectStartedAt,
          );
          recordDetails(
            agent.name,
            null,
            null,
            error instanceof Error ? error.message : String(error),
            lane.model ?? (lane.implementer === 'opencode' ? 'OpenCode CLI default' : '-'),
          );
          process.exitCode = 1;
        }
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
  // close/stop/dispose may be synchronous; never let cleanup mask the real result.
  await Promise.resolve()
    .then(() => rpc?.close?.())
    .catch(() => undefined);
  await Promise.resolve()
    .then(() => host?.stop?.())
    .catch(() => undefined);
  await Promise.resolve()
    .then(() => services?.dispose?.())
    .catch(() => undefined);
  await rm(scratchRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  console.log('\nLive delegation results');
  console.table(rows);
  console.log('\nPer-agent diagnostics (redacted)');
  for (const detail of details) {
    console.log(
      `\n${detail.agent} · Ferry session ${detail.ferrySessionId} · delegate session ${detail.delegateSessionId}`,
    );
    console.log(`  Model: ${detail.model}`);
    console.log(`  Final message: ${detail.finalMessage}`);
    console.log(`  Progress tail: ${detail.progressTail}`);
    console.log(`  OpenCode JSON event tail: ${detail.openCodeEventsTail}`);
    console.log(`  Stderr tail: ${detail.stderrTail}`);
    console.log(`  Error: ${detail.error}`);
  }
}
