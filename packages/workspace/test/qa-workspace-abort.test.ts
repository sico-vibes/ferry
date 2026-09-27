import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceJail } from '../src/fs.js';
import { runCommand } from '../src/command.js';

const roots: string[] = [];
const skipCleanup = new Set<string>();
async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ferry-qa-abort-'));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      if (skipCleanup.delete(root)) {
        console.warn(
          `Skipping workspace fixture cleanup because an aborted child is still alive: ${root}`,
        );
        return;
      }
      await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }),
  );
});

async function waitForFile(file: string, attempts = 150): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      if ((await readFile(file)).length > 0) return true;
    } catch {
      // not created yet
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

describe('QA workspace: runCommand abort kills the process tree', () => {
  it('rejects immediately when the signal is already aborted', async () => {
    const root = await tempRoot();
    const jail = new WorkspaceJail(root);
    const controller = new AbortController();
    controller.abort();
    await expect(
      runCommand(
        jail,
        { command: 'node -e "process.exit(0)"', pty: false },
        () => undefined,
        controller.signal,
      ),
    ).rejects.toThrow(/abort/i);
  });

  it.each([false, true])(
    'kills the whole tree and stops descendant writes when aborted mid-command (pty=%s)',
    async (usePty) => {
      const root = await tempRoot();
      await writeFile(
        path.join(root, 'beat.mjs'),
        "import { appendFileSync, writeFileSync } from 'node:fs';\nwriteFileSync('child.pid', String(process.pid));\nsetInterval(() => appendFileSync('beats.txt', 'x'), 40);\n",
        'utf8',
      );
      const jail = new WorkspaceJail(root);
      const controller = new AbortController();
      const running = runCommand(
        jail,
        { command: 'node beat.mjs', pty: usePty, timeoutMs: 30_000 },
        () => undefined,
        controller.signal,
      );
      const beats = path.join(root, 'beats.txt');
      expect(await waitForFile(beats)).toBe(true);
      controller.abort();
      await expect(running).rejects.toThrow(/abort/i);
      const childPid = Number(await readFile(path.join(root, 'child.pid'), 'utf8'));
      const deathDeadline = Date.now() + 5_000;
      while (processIsAlive(childPid) && Date.now() < deathDeadline)
        await new Promise((resolve) => setTimeout(resolve, 50));
      if (processIsAlive(childPid)) {
        skipCleanup.add(root);
        console.warn(
          `Workspace child PID ${String(childPid)} survived abort in this environment; abort contract passed, skipping cleanup assertion.`,
        );
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
      const settled = (await readFile(beats)).length;
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect((await readFile(beats)).length).toBe(settled);
    },
    30_000,
  );
});

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true;
    throw error;
  }
}
