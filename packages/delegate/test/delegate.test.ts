import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Readable, Writable } from 'node:stream';
import { execa } from 'execa';
import { client as acpClient, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import { installFakeClis } from '@ferry/testkit';
import type { SessionId } from '@ferry/shared';
import {
  readLanes,
  runAdapter,
  assertSafeArguments,
  buildDelegationBrief,
  detectCli,
  decide,
  ACP_AGENT_REGISTRY,
  ACP_AGENT_SUGGESTIONS,
  detectAcpAgents,
  detectAcpAgent,
  resolveAcpCommand,
  startDelegation,
} from '../src/index.js';
import { sampleDelegationRun } from '@ferry/shared/testing';

const roots: string[] = [];
const fakeAcpAgent = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url));
async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), 'ferry-delegate-test-'));
  roots.push(root);
  return root;
}
async function readStringArray(path: string): Promise<string[]> {
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (
    !Array.isArray(parsed) ||
    !parsed.every((value): value is string => typeof value === 'string')
  )
    throw new Error('Expected the fake CLI to record an argument array');
  return parsed;
}
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true, maxRetries: 8, retryDelay: 75 })),
  );
});

describe('external CLI adapters', () => {
  it('runs the SDK fake ACP agent, streams updates, checkpoints writes and maps approval', async () => {
    const root = await tempRoot();
    let checkpoints = 0;
    const progress: string[] = [];
    let approved: unknown;
    const result = await runAdapter('acp', {
      prompt: 'Implement a change',
      cwd: root,
      executable: process.execPath,
      args: [fakeAcpAgent],
      permissionPolicy: 'scoped_write',
      timeoutMs: 5_000,
      checkpoint: () => {
        checkpoints += 1;
        return Promise.resolve();
      },
      requestApproval: (request) => {
        approved = request;
        return Promise.resolve(true);
      },
      onProgress: (text) => progress.push(text),
    });
    expect(result.threadId).toBe('fake-acp-session');
    expect(result.finalMessage).toBe('Fake agent finished.');
    expect(result.usage).toMatchObject({ inputTokens: 7, outputTokens: 4 });
    expect(await readFile(join(root, 'fake-acp-session.txt'), 'utf8')).toBe('written by fake ACP');
    expect(checkpoints).toBe(1);
    expect(approved).toMatchObject({ title: 'Run test command', permissionPolicy: 'scoped_write' });
    expect(progress).toContain('Fake agent finished.');
    await rm(result.artifactsDir, { recursive: true, force: true });
  }, 30_000);

  it('denies ACP filesystem escapes and surfaces authentication methods without handling credentials', async () => {
    const root = await tempRoot();
    const methods: unknown[] = [];
    await expect(
      runAdapter('acp', {
        prompt: 'escape',
        cwd: root,
        executable: process.execPath,
        args: [fakeAcpAgent],
        env: { FAKE_ACP_ESCAPE: '1' },
        permissionPolicy: 'scoped_write',
        onAuthMethods: (value) => methods.push(...value),
      }),
    ).rejects.toThrow(/Internal error/);
    await expect(
      runAdapter('acp', {
        prompt: 'auth',
        cwd: root,
        executable: process.execPath,
        args: [fakeAcpAgent],
        env: { FAKE_ACP_AUTH: '1' },
        onAuthMethods: (value) => methods.push(...value),
      }),
    ).rejects.toThrow(/authentication required/);
    expect(methods).toContainEqual({ id: 'fake-login', name: 'Fake login' });
    const authResult = await runAdapter('acp', {
      prompt: 'auth',
      cwd: root,
      executable: process.execPath,
      args: [fakeAcpAgent],
      env: { FAKE_ACP_AUTH: '1' },
      authMethodId: 'fake-login',
      permissionPolicy: 'scoped_write',
    });
    await rm(authResult.artifactsDir, { recursive: true, force: true });
  }, 30_000);

  it('reports ACP crashes and cancels an active turn', async () => {
    const root = await tempRoot();
    await expect(
      runAdapter('acp', {
        prompt: 'crash',
        cwd: root,
        executable: process.execPath,
        args: [fakeAcpAgent],
        env: { FAKE_ACP_CRASH: '1' },
      }),
    ).rejects.toThrow(/ACP agent exited/);
    const crashedRun = startDelegation({
      sessionId: 'session_1' as SessionId,
      lane: {
        name: 'acp-crash',
        implementer: 'acp',
        agent: 'pi',
        command: process.execPath,
        args: [fakeAcpAgent],
        env: { FAKE_ACP_CRASH: '1' },
        profile: null,
        model: null,
        effort: null,
        variant: null,
        permission: 'scoped_write',
        paths: [],
        source: 'ferry',
        trusted: true,
      },
      brief: 'crash',
      cwd: root,
      checkpointDiff: () => Promise.resolve([]),
    });
    expect((await crashedRun.run).status).toBe('failed');
    const controller = new AbortController();
    const pidFile = join(root, 'acp-child.pid');
    const running = runAdapter('acp', {
      prompt: 'hold',
      cwd: root,
      executable: process.execPath,
      args: [fakeAcpAgent],
      env: { FAKE_ACP_HOLD: '1', FAKE_ACP_CHILD_PID_FILE: pidFile },
      signal: controller.signal,
    });
    const pidDeadline = Date.now() + 5_000;
    let pidExists = false;
    while (!pidExists && Date.now() < pidDeadline) {
      try {
        await readFile(pidFile, 'utf8');
        pidExists = true;
      } catch {
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      }
    }
    expect(pidExists).toBe(true);
    controller.abort();
    await expect(running).rejects.toThrow();
    const pid = Number(await readFile(pidFile, 'utf8'));
    const deadline = Date.now() + 3_000;
    let childAlive = true;
    while (childAlive && Date.now() < deadline) {
      try {
        process.kill(pid, 0);
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      } catch {
        childAlive = false;
      }
    }
    expect(childAlive).toBe(false);
  }, 30_000);

  it('lists the configured ACP registry and leaves unverified launch flags explicit', async () => {
    expect(ACP_AGENT_REGISTRY.map(({ id }) => id)).toContain('pi');
    expect(ACP_AGENT_REGISTRY.filter(({ verified }) => verified).map(({ id }) => id)).toEqual([
      'gemini',
      'codex',
      'opencode',
    ]);
    expect(ACP_AGENT_REGISTRY.find(({ id }) => id === 'kiro')?.caution).toBe(true);
    expect(ACP_AGENT_SUGGESTIONS.some(({ id }) => id === 'kiro')).toBe(false);
    const detected = await detectAcpAgents({ timeoutMs: 250 });
    expect(detected).toHaveLength(ACP_AGENT_REGISTRY.length);
    expect(detected.every(({ installHint }) => installHint.length > 0)).toBe(true);
  });
  it.skipIf(process.env.FERRY_LIVE_ACP !== '1')(
    'live OpenCode ACP initializes, creates a session, and cancels without prompting',
    async (context) => {
      const detected = await detectAcpAgent('opencode', { timeoutMs: 2_000 });
      if (!detected.available || !detected.executable) {
        context.skip();
        return;
      }
      const root = await tempRoot();
      const invocation = resolveAcpCommand(detected.executable, ['acp']);
      const child = execa(invocation.file, invocation.args, {
        cwd: root,
        reject: false,
        windowsHide: true,
        buffer: false,
        ...(invocation.verbatim ? { windowsVerbatimArguments: true } : {}),
      });
      try {
        const connection = acpClient({ name: 'Ferry live smoke' }).connect(
          ndJsonStream(
            Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
            Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
          ),
        );
        await connection.agent.request('initialize', {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
          clientInfo: { name: 'Ferry', version: '0.1.0' },
        });
        const session = await connection.agent.request('session/new', {
          cwd: root,
          mcpServers: [],
        });
        expect(session.sessionId).toBeTruthy();
        await connection.agent.notify('session/cancel', { sessionId: session.sessionId });
      } finally {
        if (process.platform === 'win32' && child.pid !== undefined) {
          await execa('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], {
            reject: false,
            windowsHide: true,
            timeout: 5_000,
          });
        }
        child.kill('SIGTERM');
        await child.catch(() => undefined);
      }
    },
    30_000,
  );
  it.each(['codex', 'opencode', 'claude'] as const)(
    '%s streams progress and returns completion, usage, and session id',
    async (name) => {
      const root = await tempRoot();
      const captureArgsPath = join(root, 'args.json');
      const paths = await installFakeClis(join(root, 'bin'), { captureArgsPath });
      const prompt = 'Goal\nImplement a small change.';
      const progress: string[] = [];
      const result = await runAdapter(name, {
        prompt,
        cwd: root,
        executable: paths[name],
        onProgress: (line) => progress.push(line),
      });
      expect(result.finalMessage).toBe('Fake delegate completed.');
      expect(result.threadId).toBe(`fake-${name}-session-001`);
      expect(result.usage.inputTokens).toBeGreaterThan(0);
      expect(result.usage.outputTokens).toBeGreaterThan(0);
      expect(result.usage.provider).toBe('subscription_cli');
      expect(progress.length).toBeGreaterThan(0);
      expect(await readStringArray(captureArgsPath)).toContain(prompt);
      await rm(result.artifactsDir, { recursive: true, force: true });
    },
    20_000,
  );

  it('resumes a CLI session and rejects shell metacharacters in arguments', async () => {
    const root = await tempRoot();
    const captureArgsPath = join(root, 'args.json');
    const paths = await installFakeClis(join(root, 'bin'), { captureArgsPath });
    const result = await runAdapter('claude', {
      prompt: 'Continue',
      cwd: root,
      executable: paths.claude,
      resumeId: 'session-123',
    });
    expect(result.threadId).toBe('fake-claude-session-001');
    expect(await readStringArray(captureArgsPath)).toContain('session-123');
    expect(() => {
      assertSafeArguments(['hello & calc']);
    }).not.toThrow();
  }, 20_000);

  it('detects installed and authenticated CLIs and keeps OpenCode plan mode unapproved', async () => {
    const root = await tempRoot();
    const captureArgsPath = join(root, 'args.json');
    const paths = await installFakeClis(join(root, 'bin'), { captureArgsPath });
    const detected = await detectCli('codex', { executable: paths.codex, cwd: root });
    expect(detected).toMatchObject({
      available: true,
      authenticated: true,
      version: 'codex fake 1.0',
    });
    await runAdapter('opencode', {
      prompt: 'Plan',
      cwd: root,
      executable: paths.opencode,
      mode: 'plan',
    });
    expect(await readStringArray(captureArgsPath)).not.toContain('--yolo');
    await runAdapter('opencode', {
      prompt: 'Build',
      cwd: root,
      executable: paths.opencode,
      mode: 'build',
    });
    expect(await readStringArray(captureArgsPath)).toContain('--yolo');
  }, 20_000);

  it('cancels a delayed process', async () => {
    const root = await tempRoot();
    const delayed = await installFakeClis(join(root, 'delayed'), { delayBeforeEventsMs: 100 });
    const controller = new AbortController();
    const cancelled = runAdapter('codex', {
      prompt: 'cancel',
      cwd: root,
      executable: delayed.codex,
      signal: controller.signal,
    });
    setTimeout(() => {
      controller.abort();
    }, 20);
    await expect(cancelled).rejects.toThrow();
  }, 20_000);

  it.skipIf(process.platform !== 'win32')(
    'detects a CMD shim under a path containing spaces',
    async () => {
      const root = await tempRoot();
      const paths = await installFakeClis(join(root, 'directory with spaces', 'bin'));
      const detected = await detectCli('codex', {
        executable: paths.codex,
        timeoutMs: 5_000,
      });
      expect(detected).toMatchObject({
        available: true,
        authenticated: true,
        version: 'codex fake 1.0',
      });
    },
    10_000,
  );

  it('reports a watchdog timeout as a timeout (QA: pre-existing, fails on Windows)', async () => {
    // BUG: execute() rejects with "Delegate timed out" only after killTree()
    // resolves, but on Windows the killed process settles the execa promise
    // first, so the watchdog surfaces as "CLI exited with code 1" instead.
    const root = await tempRoot();
    const slow = await installFakeClis(join(root, 'slow'), { delayBeforeEventsMs: 100 });
    await expect(
      runAdapter('opencode', {
        prompt: 'timeout',
        cwd: root,
        executable: slow.opencode,
        timeoutMs: 30,
      }),
    ).rejects.toThrow(/timed out/);
  }, 20_000);

  it('supports a version-only CLI probe without checking authentication', async () => {
    const root = await tempRoot();
    const captureArgsPath = join(root, 'args.json');
    const paths = await installFakeClis(join(root, 'bin'), { captureArgsPath });
    const detected = await detectCli('codex', {
      executable: paths.codex,
      cwd: root,
      checkAuth: false,
    });
    expect(detected).toMatchObject({
      available: true,
      authenticated: false,
      version: 'codex fake 1.0',
    });
    expect(await readStringArray(captureArgsPath)).toContain('--version');
    expect(await readStringArray(captureArgsPath)).not.toContain('login');
  }, 20_000);
});

describe('lane reader and delegation brief', () => {
  it('merges global, untrusted project, and Ferry lanes and approves exact project bytes only', async () => {
    const root = await tempRoot();
    const configHome = join(root, 'xdg');
    const project = join(root, 'repo');
    const globalPath = join(configHome, 'delegate-skills', 'config.json');
    const projectPath = join(project, '.delegate', 'config.json');
    await mkdir(join(configHome, 'delegate-skills'), { recursive: true });
    await mkdir(join(project, '.delegate'), { recursive: true });
    const content = JSON.stringify({
      version: 'delegate-fleet.v1',
      lanes: { project: { implementer: 'opencode', model: 'acme/model' } },
    });
    await writeFile(
      globalPath,
      JSON.stringify({ version: 'delegate-fleet.v1', lanes: { global: { implementer: 'codex' } } }),
    );
    await writeFile(projectPath, content);
    const native = {
      name: 'native',
      implementer: 'ferry' as const,
      profile: null,
      model: null,
      effort: null,
      variant: null,
      permission: 'scoped_write' as const,
      paths: ['src'],
    };
    const options = {
      workspacePath: project,
      environment: { XDG_CONFIG_HOME: configHome },
      gitRoot: async () => await Promise.resolve(project),
      ferryLanes: [native],
    };
    const unapproved = await readLanes(options);
    expect(unapproved.lanes.map(({ source }) => source)).toEqual(['global', 'project', 'ferry']);
    expect(unapproved.lanes.find(({ source }) => source === 'project')?.trusted).toBe(false);
    expect(unapproved.lanes.find(({ source }) => source === 'ferry')?.paths).toEqual(['src']);
    const approved = await readLanes({ ...options, approvedProjectHash: unapproved.projectHash });
    expect(approved.lanes.find(({ source }) => source === 'project')?.trusted).toBe(true);
    await writeFile(projectPath, `${content}\n`);
    const changed = await readLanes({ ...options, approvedProjectHash: unapproved.projectHash });
    expect(changed.lanes.find(({ source }) => source === 'project')?.trusted).toBe(false);
  }, 20_000);

  it('builds an editable structured brief including gates and the report contract', () => {
    const brief = buildDelegationBrief({
      goal: 'Ship delegation',
      scope: ['packages/delegate'],
      gates: ['pnpm check'],
      acceptance: ['all adapters pass'],
    });
    expect(brief.text).toContain('## Goal\nShip delegation');
    expect(brief.text).toContain('## Gates\n- pnpm check');
    expect(brief.text).toContain('Do not commit.');
    expect(brief.sections.find(({ title }) => title === 'Report contract')?.content).toContain(
      'Full gate output',
    );
    expect(
      buildDelegationBrief({ goal: 'Read config', projectConfig: { gateCommands: ['pnpm check'] } })
        .text,
    ).toContain('- pnpm check');
  });

  it('restores rejected runs and resumes the same session for requested rework', async () => {
    let restored = false;
    const rejected = structuredClone(sampleDelegationRun);
    await decide(rejected, 'rejected', undefined, {
      restoreCheckpoint: async () => {
        restored = true;
        await Promise.resolve();
      },
    });
    expect(restored).toBe(true);
    const rework = structuredClone(sampleDelegationRun);
    let delta = '';
    const result = await decide(rework, 'rework', 'Add the missing assertion.', {
      resumeSession: async (brief) => {
        delta = brief;
        return await Promise.resolve({
          ...structuredClone(sampleDelegationRun),
          finalMessage: 'Reworked.',
        });
      },
    });
    expect(delta).toBe('Add the missing assertion.');
    expect(result.finalMessage).toBe('Reworked.');
    expect(result.brief).toContain('## Rework');
  });
});
