import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { installFakeClis } from '@ferry/testkit';
import type { Lane, SessionId } from '@ferry/shared';
import {
  assertSafeArguments,
  decide,
  delegatePaths,
  readLanes,
  resolveAcpCommand,
  runAdapter,
  startDelegation,
} from '../src/index.js';

const roots: string[] = [];
async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ferry-qa-delegate-'));
  roots.push(root);
  return root;
}
const originalPath = process.env.PATH;
afterEach(async () => {
  process.env.PATH = originalPath;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 8 })),
  );
});

function lane(overrides: Partial<Lane> = {}): Lane {
  return {
    name: 'native',
    implementer: 'codex',
    profile: null,
    model: null,
    effort: null,
    variant: null,
    permission: 'scoped_write',
    paths: [],
    source: 'ferry',
    trusted: true,
    ...overrides,
  };
}

describe('QA delegate: argument safety', () => {
  it.each([['a % b'], ['a\0b'], ['line\rbreak']])('rejects shell metacharacters in %j', (arg) => {
    expect(() => {
      assertSafeArguments([arg]);
    }).toThrow(/Unsafe CLI argument/);
  });

  it('allows ordinary arguments', () => {
    expect(() => {
      assertSafeArguments(['run', '--model', 'acme/model-1', 'a normal brief']);
    }).not.toThrow();
  });

  it('allows shell operator characters contained within one argument', () => {
    expect(() => {
      assertSafeArguments(['hello & calc', 'a||b', 'left > right', 'use;next', 'a^b']);
    }).not.toThrow();
  });

  it.runIf(process.platform === 'win32')(
    'quotes shell operators inside one .cmd argv value',
    () => {
      const invocation = resolveAcpCommand('C:\\tools\\agent.cmd', ['hello & calc']);
      expect(invocation.args.at(-1)).toContain('"hello & calc"');
    },
  );

  it.each(['tool%PATH%.cmd', 'tool"quoted.cmd', 'tool\nbreak.cmd'])(
    'rejects unsafe executable names before constructing a shim command: %s',
    (executable) => {
      expect(() => resolveAcpCommand(executable, [])).toThrow(/Unsafe CLI argument/);
    },
  );

  it.each(['%COMSPEC%', 'quote"break', 'line\nbreak'])(
    'rejects embedded shell syntax in arguments: %s',
    (arg) => {
      expect(() => {
        assertSafeArguments([arg]);
      }).toThrow(/Unsafe CLI argument/);
    },
  );

  it.runIf(process.platform === 'win32')(
    'preserves a multi-line brief as a single argument through the .cmd shim',
    async () => {
      // The full brief must stay out of .cmd arguments; its attached file must
      // preserve the multiline text exactly.
      const root = await tempRoot();
      const captureArgsPath = join(root, 'args.json');
      const paths = await installFakeClis(join(root, 'bin'), { captureArgsPath });
      const prompt = 'Goal:\n  do the thing\n  then stop';
      const result = await runAdapter('opencode', {
        prompt,
        cwd: root,
        executable: paths.opencode,
        model: 'acme/model-1',
      });
      const parsedValue: unknown = JSON.parse(await readFile(captureArgsPath, 'utf8'));
      if (
        !Array.isArray(parsedValue) ||
        !parsedValue.every((value): value is string => typeof value === 'string')
      )
        throw new Error('Expected the fake CLI to record an argument array');
      const parsed = parsedValue;
      expect(parsed).toContain('acme/model-1');
      expect(parsed).not.toContain(prompt);
      expect(parsed).toContain('Follow the task in the attached brief file.');
      expect(parsed.every((argument) => !argument.includes(String.fromCharCode(10)))).toBe(true);
      const fileIndex = parsed.indexOf('--file');
      const promptFile = parsed[fileIndex + 1];
      expect(fileIndex).toBeGreaterThanOrEqual(0);
      expect(promptFile).toBeDefined();
      if (typeof promptFile !== 'string') throw new Error('OpenCode prompt file argument missing');
      expect(await readFile(promptFile, 'utf8')).toBe(prompt);
      await rm(result.artifactsDir, { recursive: true, force: true });
    },
    30_000,
  );
});

describe('QA delegate: lane trust', () => {
  it('never trusts a project lane without an exact approved hash', async () => {
    const root = await tempRoot();
    const configHome = join(root, 'xdg');
    const project = join(root, 'repo');
    await mkdir(join(configHome, 'delegate-skills'), { recursive: true });
    await mkdir(join(project, '.delegate'), { recursive: true });
    await writeFile(
      join(configHome, 'delegate-skills', 'config.json'),
      JSON.stringify({ version: 'delegate-fleet.v1', lanes: { g: { implementer: 'codex' } } }),
    );
    await writeFile(
      join(project, '.delegate', 'config.json'),
      JSON.stringify({
        version: 'delegate-fleet.v1',
        lanes: { p: { implementer: 'opencode', permission: 'scoped_write' } },
      }),
    );
    const base = {
      workspacePath: project,
      environment: { XDG_CONFIG_HOME: configHome } as NodeJS.ProcessEnv,
      gitRoot: async () => await Promise.resolve(project),
    };
    const result = await readLanes(base);
    const projectLane = result.lanes.find((item) => item.source === 'project');
    const globalLane = result.lanes.find((item) => item.source === 'global');
    expect(projectLane?.trusted).toBe(false);
    expect(globalLane?.trusted).toBe(true);
  });

  it('ignores malformed or unknown-version fleet files instead of throwing', async () => {
    const root = await tempRoot();
    const configHome = join(root, 'xdg');
    const project = join(root, 'repo');
    await mkdir(join(configHome, 'delegate-skills'), { recursive: true });
    await mkdir(join(project, '.delegate'), { recursive: true });
    await writeFile(join(configHome, 'delegate-skills', 'config.json'), '{not json');
    await writeFile(
      join(project, '.delegate', 'config.json'),
      JSON.stringify({
        version: 'delegate-fleet.v999',
        lanes: { p: { implementer: 'codex' }, q: { implementer: 'not-a-cli' } },
      }),
    );
    const result = await readLanes({
      workspacePath: project,
      environment: { XDG_CONFIG_HOME: configHome },
      gitRoot: async () => await Promise.resolve(project),
    });
    expect(result.lanes).toEqual([]);
  });
});

describe('QA delegate: lifecycle', () => {
  it('refuses to resume before the CLI has produced a session id, and cancels cleanly', async () => {
    const root = await tempRoot();
    const bin = join(root, 'bin');
    await installFakeClis(bin, { delayBeforeEventsMs: 1_500, holdOpenMs: 500 });
    process.env.PATH = `${bin}${delimiter}${originalPath ?? ''}`;
    const handle = startDelegation({
      sessionId: 'session_1' as SessionId,
      lane: lane({ implementer: 'codex' }),
      brief: 'do work',
      cwd: root,
      timeoutMs: 20_000,
      checkpointDiff: async () => await Promise.resolve([]),
    });
    await expect(handle.resume('more')).rejects.toThrow(/resume before/i);
    handle.cancel();
    const run = await handle.run;
    expect(run.status).toBe('cancelled');
  }, 30_000);

  it('rejects a rejection without a checkpoint callback and a rework without a resume callback', async () => {
    const run = {
      id: 'run_1' as never,
      sessionId: 'session_1' as never,
      lane: 'native',
      implementer: 'codex' as const,
      brief: 'b',
      status: 'completed' as const,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      progress: [],
      finalMessage: null,
      touchedFiles: [],
      gateResults: [],
      usage: null,
      decision: null,
    };
    await expect(decide(run, 'rejected')).rejects.toThrow(/checkpoint restore/i);
    await expect(decide(run, 'rework', 'delta')).rejects.toThrow(/resume/i);
    await expect(decide(run, 'rework', '   ')).rejects.toThrow(/delta brief/i);
  });

  it('contains delegate paths inside the resolved root', () => {
    const root = process.platform === 'win32' ? 'C:\\work\\repo' : '/work/repo';
    expect(delegatePaths.isWithin(root, 'src/a.ts')).toBe(true);
    expect(delegatePaths.isWithin(root, '..')).toBe(false);
    expect(delegatePaths.isWithin(root, process.platform === 'win32' ? 'D:\\x' : '/etc')).toBe(
      false,
    );
  });
});
