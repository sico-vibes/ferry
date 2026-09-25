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
  it.each([
    ['a; calc'],
    ['a && b'],
    ['a | b'],
    ['a < b'],
    ['a > b'],
    ['a ^ b'],
    ['a % b'],
    ['a ! b'],
    ['a\0b'],
  ])('rejects shell metacharacters in %j', (arg) => {
    expect(() => {
      assertSafeArguments([arg]);
    }).toThrow(/Unsafe CLI argument/);
  });

  it('allows ordinary arguments', () => {
    expect(() => {
      assertSafeArguments(['run', '--model', 'acme/model-1', 'a normal brief']);
    }).not.toThrow();
  });

  it('allows benign punctuation that is common in real briefs', () => {
    // BUG: tokenUnsafe = /[\0;&|<>^%!]/ rejects "%", "!", "&" and "|", so normal
    // briefs such as a 50%-complete note or a chained gate command ("npm test &&
    // pnpm lint") make delegation fail before any CLI is spawned.
    expect(() => {
      assertSafeArguments(['Fix the remaining 50% of the bug!']);
    }).not.toThrow();
    expect(() => {
      assertSafeArguments(['## Gates\n- npm test && pnpm lint']);
    }).not.toThrow();
  });

  it('preserves a multi-line brief as a single argument through the .cmd shim', async () => {
    // BUG: on Windows the .cmd shim goes through cmd.exe, which splits the
    // command line at embedded newlines. Every generated delegation brief is
    // multi-line markdown, but only the first line reaches the CLI (verified:
    // captured args contain "Goal:" and drop the rest).
    const root = await tempRoot();
    const captureArgsPath = join(root, 'args.json');
    const paths = await installFakeClis(join(root, 'bin'), { captureArgsPath });
    const prompt = 'Goal:\n  do the thing\n  then stop';
    await runAdapter('opencode', {
      prompt,
      cwd: root,
      executable: paths.opencode,
      model: 'acme/model-1',
    });
    const parsed: unknown = JSON.parse(await readFile(captureArgsPath, 'utf8'));
    expect(parsed).toContain('acme/model-1');
    expect(parsed).toContain(prompt);
  }, 30_000);
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
