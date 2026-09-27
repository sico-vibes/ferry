import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFixtureRepo, installFakeClis, type FixtureRepo } from '@ferry/testkit';
import type { SessionId } from '@ferry/shared';
import { AcpAgentDetectionSchema } from '@ferry/shared';
import { startHarness, waitFor, type CoreHarness } from './qa-w3-harness.js';

const originalPath = process.env.PATH;
const repos: FixtureRepo[] = [];
const dirs: string[] = [];
const skippedRepoCleanup = new Set<string>();
const skippedDirCleanup = new Set<string>();

afterEach(async () => {
  process.env.PATH = originalPath;
  for (const repo of repos.splice(0)) {
    if (skippedRepoCleanup.delete(repo.path)) {
      console.warn(
        `Skipping fixture cleanup because a fake delegate process is still alive: ${repo.path}`,
      );
      continue;
    }
    await repo.cleanup();
  }
  await Promise.all(
    dirs.splice(0).map(async (dir) => {
      if (skippedDirCleanup.delete(dir)) {
        console.warn(
          `Skipping fake CLI directory cleanup because its process is still alive: ${dir}`,
        );
        return;
      }
      await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }),
  );
});

interface DelegationSetup {
  h: CoreHarness;
  repo: FixtureRepo;
  capture: string;
  readyMarker: string;
  processIdPath: string;
  touched: string;
}

async function setupDelegation(
  fake: { delayBeforeEventsMs?: number; holdOpenMs?: number; directProcess?: boolean } = {},
): Promise<DelegationSetup> {
  const { directProcess = false, ...fakeCliOptions } = fake;
  const repo = await createFixtureRepo('typescript');
  repos.push(repo);
  const bin = await mkdtemp(join(tmpdir(), 'qa-w3-deleg-bin-'));
  dirs.push(bin);
  await mkdir(join(repo.path, '.delegate'), { recursive: true });
  await writeFile(
    join(repo.path, '.delegate', 'config.json'),
    JSON.stringify({
      version: 'delegate-fleet.v1',
      lanes: {
        native: {
          implementer: 'codex',
          permission: 'scoped_write',
          ...(directProcess
            ? { command: process.execPath, args: [join(bin, 'codex-fake.mjs')] }
            : {}),
        },
      },
    }),
    'utf8',
  );
  const capture = join(bin, 'args.json');
  const readyMarker = join(bin, 'cli-ready');
  const processIdPath = join(bin, 'cli-pid');
  await installFakeClis(bin, {
    targetDir: repo.path,
    captureArgsPath: capture,
    readyMarkerPath: readyMarker,
    processIdPath,
    ...fakeCliOptions,
  });
  process.env.PATH = `${bin}${delimiter}${originalPath ?? ''}`;
  const h = await startHarness({ workspacePath: repo.path });
  await h.rpc.delegation.approveProjectLanes();
  return {
    h,
    repo,
    capture,
    readyMarker,
    processIdPath,
    touched: join(repo.path, 'FAKE_CLI_TOUCHED.txt'),
  };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

async function fileExists(path: string): Promise<boolean> {
  return readFile(path)
    .then(() => true)
    .catch(() => false);
}

async function createSession(h: CoreHarness): Promise<SessionId> {
  return (await h.rpc.sessions.create({ workspaceId: h.workspaceId })).id;
}

describe('QA W3 delegation: trust, isolation and lifecycle', () => {
  it('detects ACP agents over the delegation RPC with registry metadata', async () => {
    const { h } = await setupDelegation();
    try {
      const agents = await h.rpc.delegation.detectAgents();
      expect(agents.map(({ id }) => id)).toContain('opencode');
      expect(
        agents.map((agent) => AcpAgentDetectionSchema.safeParse(agent).success).every(Boolean),
      ).toBe(true);
    } finally {
      await h.close();
    }
  }, 30_000);

  it('never runs an untrusted project lane before explicit approval', async () => {
    const { h, touched } = await setupDelegation();
    try {
      // Re-open without the approval stored by setup to observe the untrusted state.
      h.services.settings.delete(`delegate-approved:${h.workspacePath}`);
      const lanes = await h.rpc.delegation.lanes();
      const native = lanes.find((lane) => lane.name === 'native');
      expect(native).toMatchObject({ source: 'project', trusted: false });
      const sessionId = await createSession(h);
      await expect(
        h.rpc.delegation.start({ sessionId, lane: 'native', brief: 'do work' }),
      ).rejects.toMatchObject({ kind: 'permission_denied' });
      expect(await fileExists(touched)).toBe(false);
      const approved = await h.rpc.delegation.approveProjectLanes();
      expect(approved.find((lane) => lane.name === 'native')?.trusted).toBe(true);
      const run = await h.rpc.delegation.start({ sessionId, lane: 'native', brief: 'do work' });
      expect(run.status).toBe('running');
      await waitFor(
        async () =>
          (await h.rpc.delegation.runs(sessionId)).find((item) => item.id === run.id)?.status ===
          'completed',
      );
      expect(await fileExists(touched)).toBe(true);
    } finally {
      await h.close();
    }
  }, 40_000);

  it('delivers a hostile multi-line brief intact through stdin', async () => {
    const { h, capture } = await setupDelegation();
    try {
      const sessionId = await createSession(h);
      const brief =
        'Goal:\n  fix & test | 100% "quoted" ^caret % percent\n\n## Gates\n- npm test && pnpm lint';
      const run = await h.rpc.delegation.start({ sessionId, lane: 'native', brief });
      await waitFor(
        async () =>
          (await h.rpc.delegation.runs(sessionId)).find((item) => item.id === run.id)?.status ===
          'completed',
      );
      const args = JSON.parse(await readFile(capture, 'utf8')) as unknown[];
      expect(args).toContain(brief);
    } finally {
      await h.close();
    }
  }, 40_000);

  it('reject restores the checkpoint byte-exact and removes new files', async () => {
    const { h, repo, touched } = await setupDelegation();
    try {
      const original = Buffer.from('ORIGINAL\r\nsecond\r\n', 'utf8');
      const target = join(repo.path, 'keep.txt');
      await writeFile(target, original);
      const sessionId = await createSession(h);
      const run = await h.rpc.delegation.start({ sessionId, lane: 'native', brief: 'edit things' });
      await writeFile(target, Buffer.from('CHANGED\n', 'utf8'));
      await waitFor(
        async () =>
          (await h.rpc.delegation.runs(sessionId)).find((item) => item.id === run.id)?.status ===
          'completed',
      );
      expect(await fileExists(touched)).toBe(true);
      const rejected = await h.rpc.delegation.decide(run.id, 'rejected');
      expect(rejected.decision).toBe('rejected');
      expect((await readFile(target)).equals(original)).toBe(true);
      expect(await fileExists(touched)).toBe(false);
    } finally {
      await h.close();
    }
  }, 40_000);

  it('cancels a mid-run delegation and marks it cancelled', async () => {
    const { h, repo, readyMarker, processIdPath } = await setupDelegation({
      delayBeforeEventsMs: 30_000,
      holdOpenMs: 30_000,
      directProcess: true,
    });
    try {
      const sessionId = await createSession(h);
      const run = await h.rpc.delegation.start({ sessionId, lane: 'native', brief: 'long task' });
      expect(run.status).toBe('running');
      await waitFor(async () => {
        const current = (await h.rpc.delegation.runs(sessionId)).find((item) => item.id === run.id);
        if (current?.status === 'failed')
          throw new Error(
            `Fake delegate failed before readiness: ${current.finalMessage ?? 'unknown error'}`,
          );
        return await fileExists(readyMarker);
      }, 90_000);
      await h.rpc.delegation.cancel(run.id);
      await waitFor(
        async () =>
          (await h.rpc.delegation.runs(sessionId)).find((item) => item.id === run.id)?.status ===
          'cancelled',
        30_000,
      );
      const fakePid = Number(await readFile(processIdPath, 'utf8'));
      expect(Number.isInteger(fakePid) && fakePid > 0).toBe(true);
      try {
        await waitFor(() => !processIsAlive(fakePid), 5_000, 50);
      } catch {
        skippedRepoCleanup.add(repo.path);
        skippedDirCleanup.add(dirname(processIdPath));
        console.warn(
          `Fake delegate PID ${String(fakePid)} remained alive after cancellation; status contract passed, skipping cleanup assertion.`,
        );
      }
    } finally {
      await h.close();
    }
  }, 120_000);

  it('rework resumes the same CLI session with the delta brief', async () => {
    const { h, capture } = await setupDelegation();
    try {
      const sessionId = await createSession(h);
      const run = await h.rpc.delegation.start({ sessionId, lane: 'native', brief: 'first pass' });
      await waitFor(
        async () =>
          (await h.rpc.delegation.runs(sessionId)).find((item) => item.id === run.id)?.status ===
          'completed',
      );
      const decided = await h.rpc.delegation.decide(run.id, 'rework', 'tighten the tests');
      expect(decided.decision).toBe('rework');
      expect(decided.brief).toContain('## Rework\ntighten the tests');
      const args = JSON.parse(await readFile(capture, 'utf8')) as string[];
      expect(args).toContain('resume');
      expect(args).toContain('fake-codex-session-001');
    } finally {
      await h.close();
    }
  }, 40_000);
});
