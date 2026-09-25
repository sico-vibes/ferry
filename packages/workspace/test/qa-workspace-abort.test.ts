import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceJail } from '../src/fs.js';
import { runCommand } from '../src/command.js';

const roots: string[] = [];
async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ferry-qa-abort-'));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 8 })),
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
        "import { appendFileSync } from 'node:fs';\nsetInterval(() => appendFileSync('beats.txt', 'x'), 40);\n",
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
      await new Promise((resolve) => setTimeout(resolve, 400));
      const settled = (await readFile(beats)).length;
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect((await readFile(beats)).length).toBe(settled);
    },
    30_000,
  );
});
