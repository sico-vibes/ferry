import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installFakeClis } from '@ferry/testkit';
import {
  readLanes,
  runAdapter,
  assertSafeArguments,
  buildDelegationBrief,
  detectCli,
  decide,
} from '../src/index.js';
import { sampleDelegationRun } from '@ferry/shared/testing';

const roots: string[] = [];
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
  it.each(['codex', 'opencode', 'claude'] as const)(
    '%s streams progress and returns completion, usage, and session id',
    async (name) => {
      const root = await tempRoot();
      const paths = await installFakeClis(join(root, 'bin'));
      const progress: string[] = [];
      const result = await runAdapter(name, {
        prompt: 'Goal\nImplement a small change.',
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
    }).toThrow(/Unsafe CLI argument/);
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

  it('cancels a delayed process and enforces the watchdog timeout', async () => {
    const root = await tempRoot();
    const delayed = await installFakeClis(join(root, 'delayed'), { delayBeforeEventsMs: 1_000 });
    const controller = new AbortController();
    const cancelled = runAdapter('codex', {
      prompt: 'cancel',
      cwd: root,
      executable: delayed.codex,
      signal: controller.signal,
    });
    setTimeout(() => {
      controller.abort();
    }, 50);
    await expect(cancelled).rejects.toThrow();
    const slow = await installFakeClis(join(root, 'slow'), { delayBeforeEventsMs: 1_000 });
    await expect(
      runAdapter('opencode', {
        prompt: 'timeout',
        cwd: root,
        executable: slow.opencode,
        timeoutMs: 30,
      }),
    ).rejects.toThrow(/timed out/);
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
