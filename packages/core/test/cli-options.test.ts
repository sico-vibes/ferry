import { describe, expect, it } from 'vitest';
import { startHarness } from './qa-w3-harness.js';

describe('sessions.updateCliOptions', () => {
  it('rejects an unknown or non-CLI model ref instead of saving arbitrary options', async () => {
    const h = await startHarness();
    try {
      const session = await h.rpc.sessions.create({ workspaceId: h.workspaceId });
      const apiModel = h.services.models
        .list('openrouter')
        .find((candidate) => candidate.toolCalling);
      if (!apiModel) throw new Error('OpenRouter fixture has no tool-capable model');
      // An API model is not a discovered CLI model, so CLI options do not apply to it.
      await expect(
        h.rpc.sessions.updateCliOptions(session.id, {
          modelRef: apiModel.ref,
          options: { effort: 'high' },
        }),
      ).rejects.toThrow(/Unknown CLI model/);
      expect((await h.rpc.sessions.get(session.id)).session.cliOptions).toBeUndefined();
    } finally {
      await h.close();
    }
  }, 30_000);
});
