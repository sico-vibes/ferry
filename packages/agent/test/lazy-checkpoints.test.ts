import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ShadowCheckpoints } from '@ferry/workspace';
import { SessionIdSchema, TaskRecordSchema } from '@ferry/shared';
import { createWorkspaceTools } from '../src/tool-registry.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('lazy checkpoints', () => {
  it('snapshots only the mutated path and skips run_command', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ferry-agent-checkpoint-'));
    roots.push(root);
    const snapshot = vi
      .spyOn(ShadowCheckpoints.prototype, 'snapshot')
      .mockResolvedValue('checkpoint_test');
    const registry = createWorkspaceTools({
      workspace: root,
      sessionId: 'session_test',
      dataDir: path.join(root, '.ferry-data'),
      permissionMode: 'full_auto',
      onPart: () => undefined,
      requestApproval: () => Promise.resolve('allowed_once'),
      updateTask: () => undefined,
    });
    const context = {
      signal: new AbortController().signal,
      task: TaskRecordSchema.parse({
        sessionId: SessionIdSchema.parse('session_test'),
        goal: 'test',
        plan: [],
        decisions: [],
        touchedFiles: [],
        nextStep: null,
      }),
    };
    try {
      await registry.tools
        .find((tool) => tool.name === 'write_file')
        ?.execute({ path: 'notes.txt', content: 'hello' }, context);
      expect(snapshot).toHaveBeenCalledWith('Before Write file', ['notes.txt']);
      await registry.tools
        .find((tool) => tool.name === 'run_command')
        ?.execute({ command: 'echo hello' }, context);
      expect(snapshot).toHaveBeenCalledTimes(1);
    } finally {
      snapshot.mockRestore();
    }
  }, 30_000);
});
