import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertAcpWorkspacePath, readLanes } from '../src/index.js';
import { createHash } from 'node:crypto';

const roots: string[] = [];
vi.setConfig({ testTimeout: 30_000 });
async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  roots.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }),
      ),
  );
});

describe('ACP workspace filesystem callbacks', () => {
  it('allows workspace relative paths and rejects parent traversal and absolute escapes', async () => {
    const workspace = await temporaryDirectory('ferry-acp-workspace-');
    const outside = await temporaryDirectory('ferry-acp-outside-');
    await writeFile(join(workspace, 'inside.txt'), 'inside');
    await writeFile(join(outside, 'secret.txt'), 'secret');
    await expect(assertAcpWorkspacePath(workspace, 'inside.txt', false)).resolves.toBe(
      await realpath(join(workspace, 'inside.txt')),
    );
    await expect(
      assertAcpWorkspacePath(workspace, '../ferry-acp-outside-x', false),
    ).rejects.toThrow(/escapes/);
    await expect(
      assertAcpWorkspacePath(workspace, resolve(outside, 'secret.txt'), false),
    ).rejects.toThrow(/escapes/);
  });

  it('rejects a symlink that resolves outside the workspace', async () => {
    const workspace = await temporaryDirectory('ferry-acp-link-workspace-');
    const outside = await temporaryDirectory('ferry-acp-link-outside-');
    await writeFile(join(outside, 'secret.txt'), 'secret');
    try {
      await symlink(outside, join(workspace, 'external'), 'junction');
    } catch {
      return;
    }
    await expect(assertAcpWorkspacePath(workspace, 'external/secret.txt', false)).rejects.toThrow(
      /symlink/,
    );
  });
});

describe('project delegation lane trust pinning', () => {
  it('requires approval of the exact project configuration bytes', async () => {
    const workspace = await temporaryDirectory('ferry-lane-trust-');
    const home = await temporaryDirectory('ferry-lane-home-');
    await mkdir(join(workspace, '.delegate'), { recursive: true });
    const config = JSON.stringify({
      version: 'delegate-fleet.v1',
      lanes: {
        review: { implementer: 'acp', agent: 'codex', permission: 'read_only' },
      },
    });
    await writeFile(join(workspace, '.delegate', 'config.json'), config, 'utf8');
    const options = {
      workspacePath: workspace,
      gitRoot: () => Promise.resolve(workspace),
      environment: { USERPROFILE: home },
    };
    const unapproved = await readLanes(options);
    expect(unapproved.lanes.find((lane) => lane.source === 'project')?.trusted).toBe(false);
    const approvedProjectHash = createHash('sha256').update(config, 'utf8').digest('hex');
    const approved = await readLanes({ ...options, approvedProjectHash });
    expect(approved.lanes.find((lane) => lane.source === 'project')?.trusted).toBe(true);
    await writeFile(join(workspace, '.delegate', 'config.json'), `${config}\n`, 'utf8');
    const changed = await readLanes({ ...options, approvedProjectHash });
    expect(changed.lanes.find((lane) => lane.source === 'project')?.trusted).toBe(false);
  });
});
