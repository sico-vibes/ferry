import { spawn, spawnSync } from 'node:child_process';
import type { SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const cliDirectory = resolve(testDirectory, '..');
const cliEntry = join(cliDirectory, 'dist', 'ferry.js');
const temporaryRoots: string[] = [];
const ONE_SPAWN = 20_000;
const MANY_SPAWNS = 60_000;

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(
  args: string[],
  extra: { input?: string; cwd?: string; env?: NodeJS.ProcessEnv } = {},
): CliResult {
  const options: SpawnSyncOptionsWithStringEncoding = {
    encoding: 'utf8',
    timeout: 60_000,
    ...(extra.input === undefined ? {} : { input: extra.input }),
    ...(extra.cwd === undefined ? {} : { cwd: extra.cwd }),
    ...(extra.env === undefined ? {} : { env: extra.env }),
  };
  const result = spawnSync(process.execPath, [cliEntry, ...args], options);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function tempDirectory(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `ferry-qa-${label}-`));
  temporaryRoots.push(directory);
  return directory;
}

function jsonLines(output: string): unknown[] {
  return output
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

const ESCAPE = String.fromCharCode(27);

function containsAnsi(text: string): boolean {
  return text.includes(`${ESCAPE}[`);
}

function readTree(directory: string): string {
  if (!existsSync(directory)) return '';
  let text = '';
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    text += entry.isDirectory() ? readTree(path) : readFileSync(path, 'utf8');
  }
  return text;
}

afterAll(() => {
  for (const directory of temporaryRoots) rmSync(directory, { recursive: true, force: true });
});

describe('@ferry/cli argument parsing and exit codes', () => {
  it('rejects an unknown local engine with usage exit code 2', () => {
    const result = runCli(['quota', '--engine', 'typo']);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/Invalid --engine/);
  }, 30_000);

  it(
    'returns 0 with only JSONL on stdout for a successful run',
    () => {
      const dataDir = tempDirectory('run-ok');
      const result = runCli(['run', 'hello from the qa suite', '--json', '--data-dir', dataDir]);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      const events = jsonLines(result.stdout) as { type?: unknown }[];
      expect(events.length).toBeGreaterThan(0);
      expect(events.some((event) => event.type === 'session.delta')).toBe(true);
      expect(containsAnsi(result.stdout)).toBe(false);
    },
    ONE_SPAWN,
  );

  it(
    'keeps emoji and non-latin prompts intact on the JSONL stream',
    () => {
      const dataDir = tempDirectory('run-unicode');
      const prompt = 'héllo 😀 世界 — café';
      const result = runCli(['run', prompt, '--json', '--data-dir', dataDir]);
      expect(result.status).toBe(0);
      const events = jsonLines(result.stdout) as { message?: { parts?: { text?: string }[] } }[];
      const userText = events
        .flatMap((event) => event.message?.parts ?? [])
        .map((part) => part.text)
        .find((text) => text !== undefined);
      expect(userText).toBe(prompt);
    },
    ONE_SPAWN,
  );

  it(
    'returns approval exit code 3 when --permission ask runs without a TTY',
    () => {
      const dataDir = tempDirectory('run-ask');
      const result = runCli([
        'run',
        'fix the flaky tests',
        '--permission',
        'ask',
        '--json',
        '--data-dir',
        dataDir,
      ]);
      expect(result.status).toBe(3);
      expect(result.stderr).toBe('');
      expect(() => jsonLines(result.stdout)).not.toThrow();
    },
    ONE_SPAWN,
  );

  it(
    'returns 1 and logs to stderr when --max-steps is exceeded',
    () => {
      const dataDir = tempDirectory('run-max-steps');
      const result = runCli([
        'run',
        'hello from the qa suite',
        '--max-steps',
        '1',
        '--json',
        '--data-dir',
        dataDir,
      ]);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/Maximum step count \(1\) exceeded/);
      expect(() => jsonLines(result.stdout)).not.toThrow();
    },
    ONE_SPAWN,
  );

  it(
    'returns usage exit code 2 for bad arguments',
    () => {
      expect(runCli(['frobnicate']).status).toBe(2);
      expect(runCli(['run']).status).toBe(2);
      expect(runCli(['run', 'hi', '--permission', 'nope']).status).toBe(2);
      expect(runCli(['run', 'hi', '--max-steps', '0']).status).toBe(2);
      expect(runCli(['run', 'hi', '--max-steps', 'abc']).status).toBe(2);
      expect(runCli(['resume']).status).toBe(2);
    },
    MANY_SPAWNS,
  );

  it(
    'returns quota exit code 4 once every budget is exhausted',
    () => {
      const dataDir = tempDirectory('quota-exhausted');
      const drained = runCli(['run', 'out of capacity', '--data-dir', dataDir]);
      expect([3, 1, 0]).toContain(drained.status);
      const quota = runCli(['quota', '--json', '--data-dir', dataDir]);
      expect(quota.status).toBe(4);
      const value = JSON.parse(quota.stdout) as { stepsLeftToday: number };
      expect(value.stepsLeftToday).toBe(0);
    },
    MANY_SPAWNS,
  );

  it(
    'reports quota JSON with the documented schema',
    () => {
      const dataDir = tempDirectory('quota-schema');
      const result = runCli(['quota', '--json', '--data-dir', dataDir]);
      expect(result.status).toBe(0);
      const value = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(typeof value.stepsLeftToday).toBe('number');
      expect(typeof value.percentRemaining).toBe('number');
      expect(Array.isArray(value.perProvider)).toBe(true);
      expect(Array.isArray(value.nextResets)).toBe(true);
      expect(typeof value.updatedAt).toBe('string');
      expect(result.stderr).toBe('');
    },
    ONE_SPAWN,
  );

  it(
    'resumes a stored session as JSON',
    () => {
      const dataDir = tempDirectory('resume-json');
      const result = runCli(['resume', 'session_2', '--json', '--data-dir', dataDir]);
      expect(result.status).toBe(0);
      const event = JSON.parse(result.stdout) as { type: string; messages: unknown[] };
      expect(event.type).toBe('session.message');
      expect(Array.isArray(event.messages)).toBe(true);
    },
    ONE_SPAWN,
  );

  it(
    'recovers from a corrupt data directory instead of crashing',
    () => {
      const invalid = tempDirectory('corrupt-invalid');
      writeFileSync(join(invalid, 'cli-state.json'), 'not json at all', 'utf8');
      const wrongShape = tempDirectory('corrupt-shape');
      writeFileSync(
        join(wrongShape, 'cli-state.json'),
        '{"version":1,"data":{"providers":"nope"}}',
        'utf8',
      );
      expect(runCli(['quota', '--json', '--data-dir', invalid]).status).toBe(0);
      expect(runCli(['quota', '--json', '--data-dir', wrongShape]).status).toBe(0);
    },
    MANY_SPAWNS,
  );

  it(
    'accepts --cwd and --data-dir paths that contain spaces',
    () => {
      const root = tempDirectory('spaces');
      const dataDir = join(root, 'data dir with spaces');
      const cwd = join(root, 'work dir with spaces');
      mkdirSync(dataDir, { recursive: true });
      mkdirSync(cwd, { recursive: true });
      const result = runCli([
        'run',
        'hello from the qa suite',
        '--json',
        '--cwd',
        cwd,
        '--data-dir',
        dataDir,
      ]);
      expect(result.status).toBe(0);
      expect(() => jsonLines(result.stdout)).not.toThrow();
    },
    ONE_SPAWN,
  );
});

describe('@ferry/cli output hygiene', () => {
  it(
    'omits ANSI escapes when NO_COLOR is set',
    () => {
      const result = runCli(['providers'], {
        env: { ...process.env, NO_COLOR: '1' },
      });
      expect(containsAnsi(result.stdout)).toBe(false);
    },
    ONE_SPAWN,
  );

  it(
    'never echoes or persists a key passed to `keys set`',
    () => {
      const dataDir = tempDirectory('keys-set');
      const secret = 'sk-QA-SECRET-do-not-leak-abc123';
      const result = runCli(['keys', 'set', 'openai', '--data-dir', dataDir], {
        input: `${secret}\n`,
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Key saved.');
      expect(result.stdout).not.toContain(secret);
      expect(result.stderr).not.toContain(secret);
      expect(readTree(dataDir)).not.toContain(secret);
    },
    ONE_SPAWN,
  );

  it(
    'detects gate commands for empty, node and python projects with `init --yes`',
    () => {
      const root = tempDirectory('init');
      const empty = join(root, 'empty');
      const nodeProject = join(root, 'node project');
      const pythonProject = join(root, 'python project');
      mkdirSync(empty, { recursive: true });
      mkdirSync(nodeProject, { recursive: true });
      mkdirSync(pythonProject, { recursive: true });
      writeFileSync(
        join(nodeProject, 'package.json'),
        JSON.stringify({ scripts: { test: 'vitest', lint: 'eslint', typecheck: 'tsc' } }),
        'utf8',
      );
      writeFileSync(join(pythonProject, 'pyproject.toml'), '[project]\nname = "qa"\n', 'utf8');
      const dataDir = join(root, 'data');
      const read = (cwd: string): { gates: string[] } =>
        JSON.parse(readFileSync(join(cwd, '.ferry', 'config.json'), 'utf8')) as { gates: string[] };
      expect(runCli(['init', '--yes', '--cwd', empty, '--data-dir', dataDir]).status).toBe(0);
      expect(runCli(['init', '--yes', '--cwd', nodeProject, '--data-dir', dataDir]).status).toBe(0);
      expect(runCli(['init', '--yes', '--cwd', pythonProject, '--data-dir', dataDir]).status).toBe(
        0,
      );
      expect(read(empty).gates).toEqual([]);
      expect(read(nodeProject).gates).toEqual(['pnpm test', 'pnpm lint', 'pnpm typecheck']);
      expect(read(pythonProject).gates).toEqual(['python -m pytest']);
    },
    MANY_SPAWNS,
  );

  it(
    'prints doctor rows as text',
    () => {
      const result = runCli(['doctor']);
      expect(result.stdout).toMatch(/Node:/);
      expect(result.stdout).toMatch(/Data dir:/);
      expect([0, 1]).toContain(result.status);
    },
    ONE_SPAWN,
  );
});

describe('@ferry/cli abort handling', () => {
  it(
    'terminates promptly when interrupted mid-run',
    async () => {
      const dataDir = tempDirectory('abort');
      const child = spawn(
        process.execPath,
        [cliEntry, 'run', 'hello from the qa suite', '--json', '--data-dir', dataDir],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      try {
        const producedOutput = new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => {
            resolve(false);
          }, ONE_SPAWN);
          child.stdout.once('data', () => {
            clearTimeout(timer);
            resolve(true);
          });
        });
        expect(await producedOutput).toBe(true);
        const exited = new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => {
            resolve(false);
          }, 10_000);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve(true);
          });
        });
        child.kill('SIGINT');
        expect(await exited).toBe(true);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill();
      }
    },
    MANY_SPAWNS,
  );
});

describe('@ferry/cli known bugs (adversarial)', () => {
  it(
    'makes `providers --json` emit JSON rather than human text',
    () => {
      // BUG: providers/profiles/skills/mcp/lanes ignore --json and print human text.
      const result = runCli(['providers', '--json']);
      expect(() => {
        JSON.parse(result.stdout);
      }).not.toThrow();
    },
    ONE_SPAWN,
  );

  it(
    'makes `doctor --json` emit JSON rather than human text',
    () => {
      // BUG: doctor ignores --json (main.tsx doctor() only writes text rows).
      const result = runCli(['doctor', '--json']);
      expect(() => {
        JSON.parse(result.stdout);
      }).not.toThrow();
    },
    ONE_SPAWN,
  );

  it(
    'omits ANSI escapes for non-TTY output',
    () => {
      // BUG: ansi() only checks NO_COLOR, never process.stdout.isTTY (format.ts:9-16).
      const result = runCli(['providers']);
      expect(containsAnsi(result.stdout)).toBe(false);
    },
    ONE_SPAWN,
  );

  it(
    'exits cleanly when `keys set` receives no key on stdin',
    () => {
      // BUG: readSecret awaits 'line' but never handles EOF; Node aborts with an
      // unsettled top-level await (exit 13) instead of the usage code 2 (main.tsx:414-423).
      const dataDir = tempDirectory('keys-eof');
      const result = runCli(['keys', 'set', 'openai', '--data-dir', dataDir], { input: '' });
      expect(result.status).toBe(2);
      expect(result.stderr).not.toMatch(/unsettled top-level await/);
    },
    ONE_SPAWN,
  );

  it(
    'rejects a flag whose value is missing instead of silently ignoring it',
    () => {
      // BUG: readFlags() treats a trailing option as boolean true, then stringFlag()
      // discards it, so --max-steps/--profile/--data-dir without a value are ignored (main.tsx:246-265).
      expect(runCli(['run', 'hi', '--max-steps']).status).toBe(2);
      expect(runCli(['run', 'hi', '--profile']).status).toBe(2);
      expect(runCli(['quota', '--json', '--data-dir']).status).toBe(2);
    },
    MANY_SPAWNS,
  );

  it(
    'reports subcommand errors without leaking a raw stack trace',
    () => {
      // BUG: runCli() uses `return asyncCommand(...)` inside try/catch, so the
      // rejection is never awaited by the catch and escapes as an unhandled
      // top-level await with a full internal stack (main.tsx:159-233).
      const dataDir = tempDirectory('resume-stack');
      const result = runCli(['resume', 'does-not-exist', '--json', '--data-dir', dataDir]);
      expect(result.status).toBe(1);
      expect(result.stderr).not.toMatch(/\n\s+at /);
    },
    ONE_SPAWN,
  );
});
