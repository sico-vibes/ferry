import { expect, it } from 'vitest';
import {
  ApprovalsPendingSchema,
  CliConnectionSchema,
  CliConnectionSettingsPatchSchema,
  SessionModelUsageSchema,
} from '@ferry/shared';
import { createMockFerryClient } from '../src/index.js';

it('exposes schema-valid installed CLI connections from the mock client', async () => {
  const client = createMockFerryClient();
  const connections = await client.cliConnections.list();
  expect(connections.map((connection) => connection.kind)).toEqual([
    'codex-cli',
    'claude-code-cli',
    'opencode-cli',
  ]);
  for (const connection of connections) CliConnectionSchema.parse(connection);
  for (const connection of await client.cliConnections.refresh('codex-cli'))
    CliConnectionSchema.parse(connection);
});

it('persists surface opt-ins and returns the updated connection', async () => {
  const client = createMockFerryClient();
  const updated = await client.cliConnections.update('codex-cli', {
    surfaces: { native: true, gateway: true },
  });
  expect(updated.surfaces).toEqual({ native: true, gateway: true });
  const listed = (await client.cliConnections.list()).find(
    (connection) => connection.kind === 'codex-cli',
  );
  expect(listed?.surfaces).toEqual({ native: true, gateway: true });
});

it('keeps CLI opt-ins after an unrelated settings update', async () => {
  const client = createMockFerryClient();
  await client.cliConnections.update('codex-cli', {
    surfaces: { native: true, gateway: true },
    defaultOptions: { effort: 'high' },
  });
  await client.settings.update({ theme: 'light' });
  const connection = (await client.cliConnections.list()).find(
    (entry) => entry.kind === 'codex-cli',
  );
  expect(connection?.surfaces).toEqual({ native: true, gateway: true });
});

it('mirrors real OpenCode Go and Claude control evidence', async () => {
  const client = createMockFerryClient();
  const connections = await client.cliConnections.list();
  const opencodeModel = connections.find((entry) => entry.kind === 'opencode-cli')?.models[0];
  expect(opencodeModel?.ref).toBe('opencode-cli/opencode-go/deepseek-v4.1-flash');
  expect(opencodeModel?.efforts).toEqual(['low', 'high', 'max']);
  expect(opencodeModel?.billing).toBe('included_subscription');
  const claude = connections.find((entry) => entry.kind === 'claude-code-cli');
  expect(claude?.usage.state).toBe('available');
  expect(claude?.usage.source).toBe('claude control get_usage');
  expect(claude?.models[0]?.efforts).toContain('max');
});

it('returns a scripted verification receipt and marks the model verified', async () => {
  const client = createMockFerryClient();
  const result = await client.cliConnections.verify('claude-code-cli');
  expect(result.ok).toBe(true);
  expect(result.modelRef).toBe('claude-code-cli/claude-opus-5-5');
  const connection = (await client.cliConnections.list()).find(
    (entry) => entry.kind === 'claude-code-cli',
  );
  expect(connection?.verify.state).toBe('verified');
  expect(connection?.verify.modelRef).toBe('claude-code-cli/claude-opus-5-5');
});

it('distinguishes an explicit null effort from an absent one in CLI patches', () => {
  const cleared = CliConnectionSettingsPatchSchema.parse({ defaultOptions: { effort: null } });
  expect(cleared.defaultOptions && 'effort' in cleared.defaultOptions).toBe(true);
  expect(cleared.defaultOptions?.effort).toBeNull();
  const preserved = CliConnectionSettingsPatchSchema.parse({ defaultOptions: { speed: 'fast' } });
  expect(preserved.defaultOptions && 'effort' in preserved.defaultOptions).toBe(false);
});

it('exposes session model usage and pending approvals schemas', async () => {
  const client = createMockFerryClient();
  const session = (await client.sessions.list())[0];
  if (!session) throw new Error('Mock session fixture missing');
  SessionModelUsageSchema.parse(await client.sessions.modelUsage(session.id));
  ApprovalsPendingSchema.parse(await client.approvals.pending());
});

it('round-trips unreported (null) totals distinctly from a reported zero', async () => {
  const client = createMockFerryClient();
  const session = (await client.sessions.list())[0];
  if (!session) throw new Error('Mock session fixture missing');
  const base = {
    sessionId: session.id,
    models: [],
    incomplete: false,
    coverage: { since: null, missing: false },
  };
  const missing = SessionModelUsageSchema.parse({
    ...base,
    totals: {
      requests: 1,
      inputTokens: null,
      outputTokens: null,
      cachedTokens: null,
      reasoningTokens: null,
    },
  });
  const zero = SessionModelUsageSchema.parse({
    ...base,
    totals: {
      requests: 1,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      reasoningTokens: 0,
    },
  });
  expect(missing.totals.inputTokens).toBeNull();
  expect(zero.totals.inputTokens).toBe(0);
});
