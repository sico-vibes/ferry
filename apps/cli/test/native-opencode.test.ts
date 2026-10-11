import { afterEach, expect, it, vi } from 'vitest';
import type { FerryClient } from '@ferry/client';
import { runTool } from '../src/tools.js';

afterEach(() => vi.restoreAllMocks());
it('previews native OpenCode without reading credentials, creating keys or starting the Gateway', async () => {
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const client = {} as unknown as FerryClient;
  expect(
    await runTool(client, 'opencode', {
      native: true,
      preview: true,
      json: true,
      model: 'opencode/big-pickle',
    }),
  ).toBe(0);
  expect(JSON.parse(output.mock.calls.map(([chunk]) => String(chunk)).join(''))).toEqual({
    command: 'opencode',
    args: ['--model', 'opencode/big-pickle'],
    env: {},
  });
});
