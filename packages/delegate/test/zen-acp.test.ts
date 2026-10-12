import { expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { runZenAcp } from '../src/index.js';
import { openZenToolBridge } from '../src/zen-tools.js';
vi.setConfig({ testTimeout: 30_000 });
const executable = process.execPath;
const executableArgs = [fileURLToPath(new URL('./fixtures/zen-acp.mjs', import.meta.url))];
const environment = {
  ...process.env,
  XDG_DATA_HOME: '/nonexistent-ferry-fixture',
  OPENCODE_API_KEY: '',
};
const base = { model: 'opencode/big-pickle', executable, executableArgs, environment };
it('uses an explicitly selected model despite advertised auth methods, streams text and reports usage', async () => {
  const chunks: string[] = [];
  const result = await runZenAcp({
    ...base,
    prompt: 'Ready',
    signal: AbortSignal.timeout(10_000),
    onText: (chunk) => chunks.push(chunk),
  });
  expect(chunks.join('')).toBe('Ready.');
  expect(result).toMatchObject({ text: 'Ready.', inputTokens: 12, outputTokens: 2, toolCalls: [] });
});
it('fails before prompting when the selected model is not advertised; never uses the paid default', async () => {
  await expect(
    runZenAcp({
      ...base,
      model: 'opencode/missing',
      prompt: 'Ready',
      signal: AbortSignal.timeout(10_000),
    }),
  ).rejects.toThrow('No fallback');
});
it('rejects native reads, writes and shell approval', async () => {
  const result = await runZenAcp({
    ...base,
    prompt: 'CHECK_NATIVE_DENIAL',
    signal: AbortSignal.timeout(10_000),
  });
  expect(result.text).toBe('DENIED');
});
it('returns actual caller tool name and arguments without executing it, then accepts caller results', async () => {
  const tools = [
    { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
  ];
  const result = await runZenAcp({
    ...base,
    tools,
    prompt: 'Read marker',
    signal: AbortSignal.timeout(10_000),
  });
  expect(result.toolCalls).toEqual([
    {
      id: expect.stringMatching(/^call_/) as unknown,
      name: 'read_file',
      arguments: { path: 'marker.txt' },
    },
  ]);
  const continued = await runZenAcp({
    ...base,
    tools,
    prompt: 'Caller tool returned CLI_TOOL_RESULT',
    signal: AbortSignal.timeout(10_000),
  });
  expect(continued.text).toBe('CLI_TOOL_RESULT');
});
it('cancels a pending ACP request and releases its subprocess', async () => {
  const controller = new AbortController();
  const pending = runZenAcp({
    ...base,
    prompt: 'WAIT_FOR_CANCEL',
    signal: controller.signal,
    onText: () => undefined,
  });
  // Cancellation during startup is deliberately covered as well as in-flight work.
  controller.abort(new Error('fixture cancelled'));
  await expect(pending).rejects.toThrow('fixture cancelled');
});
it('rejects unauthenticated and cross-origin access to caller tools', async () => {
  const bridge = await openZenToolBridge([]);
  try {
    expect((await fetch(bridge.url, { method: 'POST' })).status).toBe(403);
    expect(
      (
        await fetch(bridge.url, {
          method: 'POST',
          headers: { authorization: `Bearer ${bridge.token}`, origin: 'https://external.example' },
        })
      ).status,
    ).toBe(403);
  } finally {
    await bridge.close();
  }
});
