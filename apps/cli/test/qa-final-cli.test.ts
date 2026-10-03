import { spawnSync } from 'node:child_process';
import type { SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const cliEntry = join(resolve(testDirectory, '..'), 'dist', 'ferry.js');
const temporaryRoots: string[] = [];

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function tempDirectory(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `ferry-qa-final-${label}-`));
  temporaryRoots.push(directory);
  return directory;
}

function runCli(args: string[], extra: { input?: string } = {}): CliResult {
  const options: SpawnSyncOptionsWithStringEncoding = {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, FERRY_ENGINE: 'mock' },
    ...(extra.input === undefined ? {} : { input: extra.input }),
  };
  const result = spawnSync(process.execPath, [cliEntry, ...args], options);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

afterAll(async () => {
  await Promise.all(
    temporaryRoots.map((directory) =>
      rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }),
    ),
  );
});

describe('QA final: profile role settings persistence', () => {
  it('round-trips roles through ferry profiles roles set and show', () => {
    const dataDir = tempDirectory('roles');
    const set = runCli([
      'profiles',
      'roles',
      'set',
      'Auto-Free',
      'on',
      'planner=auto',
      'editor=auto',
      '--json',
      '--data-dir',
      dataDir,
    ]);
    expect(set.status).toBe(0);
    const saved = JSON.parse(set.stdout) as {
      profile: string;
      roles: { enabled: boolean; plannerModelRef: string | null; editorModelRef: string | null };
    };
    expect(saved.profile).toBe('Auto-Free');
    expect(saved.roles).toMatchObject({
      enabled: true,
      plannerModelRef: null,
      editorModelRef: null,
    });

    const shown = runCli([
      'profiles',
      'roles',
      'show',
      'Auto-Free',
      '--json',
      '--data-dir',
      dataDir,
    ]);
    expect(shown.status).toBe(0);
    expect(JSON.parse(shown.stdout)).toMatchObject({ roles: saved.roles });

    const off = runCli([
      'profiles',
      'roles',
      'set',
      'Auto-Free',
      'off',
      '--json',
      '--data-dir',
      dataDir,
    ]);
    expect(off.status).toBe(0);
    expect(JSON.parse(off.stdout)).toMatchObject({ roles: { enabled: false } });
  }, 60_000);

  it('rejects an unknown profile name with usage exit code 2', () => {
    const dataDir = tempDirectory('roles-unknown');
    const result = runCli([
      'profiles',
      'roles',
      'show',
      'No Such Profile',
      '--json',
      '--data-dir',
      dataDir,
    ]);
    expect(result.status).toBe(2);
    const payload = JSON.parse(result.stdout) as { error: { code: number } };
    expect(payload.error.code).toBe(2);
  }, 60_000);
});

describe('QA final: settings routing and provider doctor hygiene', () => {
  it('lists routing toggles and persists a set through JSON output', () => {
    const dataDir = tempDirectory('routing');
    const listed = runCli(['settings', 'routing', 'list', '--json', '--data-dir', dataDir]);
    expect(listed.status).toBe(0);
    const rows = JSON.parse(listed.stdout) as Record<string, unknown>;
    expect(rows).toHaveProperty('sticky-sessions');
    expect(rows).toHaveProperty('avoid-training-providers');
    expect(rows['sticky-sessions']).toBe(true);
    const human = runCli(['settings', 'routing', 'list', '--data-dir', dataDir]);
    expect(human.status).toBe(0);
    expect(human.stdout).toContain('sticky-sessions: true');
    expect(human.stdout).toContain('provider-priorities: {}');

    const set = runCli([
      'settings',
      'routing',
      'set',
      'sticky-sessions',
      'off',
      '--json',
      '--data-dir',
      dataDir,
    ]);
    expect(set.status).toBe(0);
    expect(JSON.parse(set.stdout)).toEqual({ key: 'sticky-sessions', enabled: false });

    const relisted = runCli(['settings', 'routing', 'list', '--json', '--data-dir', dataDir]);
    expect((JSON.parse(relisted.stdout) as Record<string, unknown>)['sticky-sessions']).toBe(false);
  }, 60_000);

  it('never echoes a stored provider key through ferry doctor --providers --json', () => {
    const dataDir = tempDirectory('doctor');
    const sentinel = 'SENTINEL-DOCTOR-SECRET-0123456789';
    const setKey = runCli(['keys', 'set', 'groq', '--json', '--data-dir', dataDir], {
      input: `${sentinel}\n`,
    });
    expect(setKey.status).toBe(0);

    const doctor = runCli(['doctor', '--providers', '--json', '--data-dir', dataDir]);
    expect(doctor.status).toBe(0);
    const report = JSON.parse(doctor.stdout) as {
      provider: string;
      keyStatus: string;
    }[];
    expect(report.some((row) => row.provider === 'groq')).toBe(true);
    expect(doctor.stdout).not.toContain(sentinel);
    expect(doctor.stderr).not.toContain(sentinel);
  }, 60_000);
});
