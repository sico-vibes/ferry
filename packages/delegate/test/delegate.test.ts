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
  buildCliArgs,
  readOpenCodeDefaultModel,
  mapCliEvent,
  mapAcpUpdate,
} from '../src/index.js';
import { sampleDelegationRun } from '@ferry/shared/testing';

const roots: string[] = [];
const fakeAcpAgent = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url));

describe('recorded native agent event fixtures', () => {
  it.each(['codex', 'claude', 'opencode'] as const)(
    '%s JSONL maps to normalized events',
    async (name) => {
      const path = new URL(`../../testkit/fixtures/agent-events/${name}.jsonl`, import.meta.url);
      const lines = (await readFile(path, 'utf8')).trim().split(/\r?\n/);
      const events = lines.flatMap((line) =>
        mapCliEvent(name, JSON.parse(line) as Record<string, unknown>),
      );
      expect(events.some((event) => event.type === 'text')).toBe(true);
      if (name === 'codex') expect(events.map((event) => event.type)).toContain('tool_use');
      if (name === 'claude') {
        expect(events.map((event) => event.type)).toContain('thinking');
        expect(events.map((event) => event.type)).toContain('tool_result');
      }
      if (name === 'opencode') {
        expect(events.filter((event) => event.type === 'tool_use')).toHaveLength(1);
        expect(events.some((event) => event.type === 'usage')).toBe(true);
      }
    },
  );
  it('maps recorded ACP session/update kinds', async () => {
    const path = new URL('../../testkit/fixtures/agent-events/acp.jsonl', import.meta.url);
    const rows = (await readFile(path, 'utf8'))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as unknown);
    const events = rows.flatMap(mapAcpUpdate);
    expect(events.map((event) => event.type)).toEqual([
      'text',
      'thinking',
      'tool_use',
      'tool_result',
      'status',
    ]);
  });
});
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
    let childPid: number | undefined;
    while (childPid === undefined && Date.now() < pidDeadline) {
      try {
        const candidate = Number(await readFile(pidFile, 'utf8'));
        if (Number.isSafeInteger(candidate) && candidate > 1 && candidate !== process.pid)
          childPid = candidate;
      } catch {
        // The agent atomically renames the complete PID file into place.
      }
      if (childPid === undefined) await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    expect(childPid).toBeDefined();
    controller.abort();
    await expect(running).rejects.toThrow();
    const deadline = Date.now() + 3_000;
    let childAlive = true;
    while (childAlive && Date.now() < deadline) {
      try {
        if (!Number.isSafeInteger(childPid) || childPid === undefined || childPid <= 1)
          throw new Error('Invalid fake ACP child PID');
        process.kill(childPid, 0);
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
        detached: process.platform !== 'win32',
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
          clientInfo: { name: 'Ferry', version: '0.9.0' },
        });
        const session = await connection.agent.request('session/new', {
          cwd: root,
          mcpServers: [],
        });
        expect(session.sessionId).toBeTruthy();
        await connection.agent.notify('session/cancel', { sessionId: session.sessionId });
      } finally {
        if (process.platform === 'win32') {
          child.kill('SIGTERM');
        } else if (
          Number.isSafeInteger(child.pid) &&
          child.pid !== undefined &&
          child.pid > 1 &&
          child.pid !== process.pid
        ) {
          try {
            process.kill(-child.pid, 'SIGTERM');
          } catch {
            child.kill('SIGTERM');
          }
        }
        if (process.platform === 'win32' && child.pid !== undefined) {
          try {
            await execa('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], {
              reject: false,
              windowsHide: true,
              timeout: 5_000,
            });
          } catch {
            // The direct child has already received a kill signal.
          }
        }
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
      const events: import('@ferry/shared').AgentEvent[] = [];
      const result = await runAdapter(name, {
        prompt,
        cwd: root,
        executable: paths[name],
        ...(name === 'opencode' ? { model: 'openai/gpt-test' } : {}),
        onProgress: (line) => progress.push(line),
        onEvent: (event) => events.push(event),
      });
      expect(result.finalMessage).toBe('Fake delegate completed.');
      expect(result.threadId).toBe(`fake-${name}-session-001`);
      expect(result.usage.inputTokens).toBeGreaterThan(0);
      expect(result.usage.outputTokens).toBeGreaterThan(0);
      expect(result.usage.provider).toBe('subscription_cli');
      expect(progress.length).toBeGreaterThan(0);
      if (name === 'opencode') {
        expect(events.map((event) => event.type)).toEqual(
          expect.arrayContaining(['text', 'tool_use', 'tool_result', 'usage']),
        );
        expect(events.find((event) => event.type === 'tool_use')).toMatchObject({
          callId: 'call_fake',
          tool: 'bash',
        });
      }
      const captured = await readStringArray(captureArgsPath);
      if (name === 'opencode') {
        const fileIndex = captured.indexOf('--file');
        const promptFile = captured[fileIndex + 1];
        expect(fileIndex).toBeGreaterThanOrEqual(0);
        expect(promptFile).toBeDefined();
        expect(captured).not.toContain(prompt);
        expect(captured).toContain('Follow the task in the attached brief file.');
        if (!promptFile) throw new Error('OpenCode prompt file argument missing');
        expect(await readFile(promptFile, 'utf8')).toBe(prompt);
      } else expect(captured).toContain(prompt);
      await rm(result.artifactsDir, { recursive: true, force: true });
    },
    20_000,
  );

  it('uses the Codex 0.159 resume syntax from its installed version and usage fixture', async () => {
    const root = await tempRoot();
    const usage = await readFile(
      new URL('./fixtures/codex-0.159-resume-usage.txt', import.meta.url),
      'utf8',
    );
    expect(usage).toContain(
      'Usage: codex exec resume --json --output-last-message <FILE> <SESSION_ID> [PROMPT]',
    );
    const captureArgsPath = join(root, 'args.json');
    const paths = await installFakeClis(join(root, 'bin'), {
      captureArgsPath,
      versions: { codex: 'codex-cli 0.159.0' },
    });
    const prompt = 'Continue this session';
    const outputPath = join(root, 'final.txt');
    const result = await runAdapter('codex', {
      prompt,
      cwd: root,
      executable: paths.codex,
      resumeId: 'codex-session-159',
      model: 'inherited-model',
      effort: 'high',
    });
    expect(await readStringArray(captureArgsPath)).toEqual([
      'exec',
      'resume',
      '--json',
      '--output-last-message',
      expect.stringMatching(/codex-final\.txt$/),
      'codex-session-159',
      prompt,
    ]);
    expect(
      buildCliArgs(
        'codex',
        { prompt, cwd: root, resumeId: 'old-session', model: 'old-model' },
        outputPath,
        'codex-cli 0.158.0',
      ),
    ).toContain('--sandbox');
    await rm(result.artifactsDir, { recursive: true, force: true });
  }, 20_000);

  it('fails clearly when OpenCode exits without assistant text', async () => {
    const root = await tempRoot();
    const paths = await installFakeClis(join(root, 'bin'), {
      events: [{ type: 'session', sessionID: 'fake-opencode-empty-session' }],
    });
    await expect(
      runAdapter('opencode', {
        prompt: 'Return a tiny test',
        cwd: root,
        executable: paths.opencode,
        model: 'openai/gpt-test',
        mode: 'build',
      }),
    ).rejects.toThrow(/OpenCode exited without assistant text.*1 JSON events/);
  }, 20_000);

  it('keeps OpenCode and Claude resume argument forms supported by their CLIs', () => {
    const request = {
      prompt: 'Continue',
      cwd: 'C:\\fixture',
      resumeId: 'session-1',
      promptFilePath: 'C:\\fixture\\brief.md',
    };
    const opencode = buildCliArgs('opencode', request, 'output.txt');
    expect(opencode).toContain('--session');
    expect(opencode).toContain('--dir');
    expect(opencode).toContain('C:\\fixture\\brief.md');
    expect(opencode).not.toContain(request.prompt);
    expect(opencode).toContain('Follow the task in the attached brief file.');
    expect(opencode).toContain('session-1');
    const claude = buildCliArgs('claude', request, 'output.txt');
    expect(claude).toContain('--resume');
    expect(claude).toContain('session-1');
  });

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

  it('uses the Codex 0.159 exec resume argument shape', async () => {
    const root = await tempRoot();
    const captureArgsPath = join(root, 'codex-args.json');
    const paths = await installFakeClis(join(root, 'bin'), { captureArgsPath });
    const result = await runAdapter('codex', {
      prompt: 'Continue the same session',
      cwd: root,
      executable: paths.codex,
      resumeId: 'codex-session-123',
    });
    expect(result.threadId).toBe('fake-codex-session-001');
    const args = await readStringArray(captureArgsPath);
    expect(args.slice(0, 3)).toEqual(['exec', 'resume', 'codex-session-123']);
    expect(args).toContain('--json');
    expect(args).toContain('-');
    expect(args).not.toContain('--sandbox');
    expect(args).not.toContain('--cd');
  }, 20_000);

  it('detects installed and authenticated CLIs and keeps OpenCode plan mode unapproved', async () => {
    const root = await tempRoot();
    const captureArgsPath = join(root, 'args.json');
    const captureCwdPath = join(root, 'cwd.txt');
    const paths = await installFakeClis(join(root, 'bin'), { captureArgsPath, captureCwdPath });
    const detected = await detectCli('codex', { executable: paths.codex, cwd: root });
    expect(detected).toMatchObject({
      available: true,
      authenticated: true,
      version: 'codex fake 1.0',
    });
    const planRun = await runAdapter('opencode', {
      prompt: 'Plan',
      cwd: root,
      executable: paths.opencode,
      model: 'openai/gpt-test',
      mode: 'plan',
    });
    expect(await readStringArray(captureArgsPath)).not.toContain('--auto');
    const buildRun = await runAdapter('opencode', {
      prompt: 'Build',
      cwd: root,
      executable: paths.opencode,
      model: 'openai/gpt-test',
      mode: 'build',
    });
    const buildArgs = await readStringArray(captureArgsPath);
    expect(buildArgs).toContain('--auto');
    expect(buildArgs).toContain('--dir');
    expect(buildArgs).toContain(root);
    expect(buildArgs).toContain('--model');
    expect(buildArgs).toContain('openai/gpt-test');
    const briefIndex = buildArgs.indexOf('--file');
    const briefPath = buildArgs[briefIndex + 1];
    expect(briefIndex).toBeGreaterThanOrEqual(0);
    expect(briefPath).toBeDefined();
    expect(buildArgs).not.toContain('Build');
    expect(buildArgs).toContain('Follow the task in the attached brief file.');
    if (!briefPath) throw new Error('OpenCode prompt file argument missing');
    expect(await readFile(briefPath, 'utf8')).toBe('Build');
    expect(await readFile(captureCwdPath, 'utf8')).toBe(root);
    await Promise.all([
      rm(planRun.artifactsDir, { recursive: true, force: true }),
      rm(buildRun.artifactsDir, { recursive: true, force: true }),
    ]);
  }, 20_000);
  it('reads the configured OpenCode model and gives a clear error when none exists', async () => {
    const root = await tempRoot();
    const configHome = join(root, 'config');
    await mkdir(join(configHome, 'opencode'), { recursive: true });
    await writeFile(join(configHome, 'opencode', 'opencode.jsonc'), '{"model":"provider/model",}');
    expect(
      await readOpenCodeDefaultModel(root, { USERPROFILE: root, XDG_CONFIG_HOME: configHome }),
    ).toBe('provider/model');

    const laneConfigHome = join(root, 'ferry-config');
    await mkdir(join(laneConfigHome, 'delegate-skills'), { recursive: true });
    await writeFile(
      join(laneConfigHome, 'delegate-skills', 'config.json'),
      JSON.stringify({
        version: 'delegate-fleet.v1',
        lanes: { opencode: { implementer: 'opencode' } },
      }),
    );
    const lanes = await readLanes({
      workspacePath: root,
      environment: { XDG_CONFIG_HOME: laneConfigHome },
      opencodeEnvironment: { USERPROFILE: root, XDG_CONFIG_HOME: configHome },
      gitRoot: () => Promise.resolve(null),
    });
    expect(lanes.lanes[0]?.model).toBe('provider/model');

    const captureArgsPath = join(root, 'args.json');
    const paths = await installFakeClis(join(root, 'bin'), { captureArgsPath });
    await runAdapter('opencode', {
      prompt: 'Use the configured model',
      cwd: root,
      executable: paths.opencode,
      env: { USERPROFILE: root, XDG_CONFIG_HOME: configHome },
    });
    const args = await readStringArray(captureArgsPath);
    expect(args).toContain('--model');
    expect(args).toContain('provider/model');

    await expect(
      runAdapter('opencode', {
        prompt: 'Run without a selected model',
        cwd: root,
        executable: paths.opencode,
        env: { USERPROFILE: root, XDG_CONFIG_HOME: join(root, 'empty-config') },
      }),
    ).rejects.toThrow(/Choose a model for OpenCode in Settings/);
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

  it.runIf(process.platform === 'win32')(
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

  it('reports a watchdog timeout as a timeout', async () => {
    const root = await tempRoot();
    const slow = await installFakeClis(join(root, 'slow'), { delayBeforeEventsMs: 100 });
    await expect(
      runAdapter('opencode', {
        prompt: 'timeout',
        cwd: root,
        executable: slow.opencode,
        model: 'openai/gpt-test',
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

  it.runIf(process.platform !== 'win32')(
    'surfaces CLI spawn errors with the operating system error and command',
    async () => {
      const root = await tempRoot();
      const executable = join(root, 'missing-fake-cli');
      await expect(
        runAdapter('codex', {
          prompt: 'cannot start',
          cwd: root,
          executable,
        }),
      ).rejects.toThrow(/Failed to start CLI \((?:ENOENT|EACCES)\):.*missing-fake-cli/);
    },
  );
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
