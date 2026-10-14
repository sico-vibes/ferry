import { expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import {
  deriveCliAccountKey,
  discoverCliConnection,
  discoverCliUsage,
  parseClaudeAuthStatus,
  parseOpencodeAuthStore,
  parseOpencodeModelsVerbose,
} from '../src/index.js';
import { CliConnectionSchema } from '@ferry/shared';

const executable = process.execPath;
const fixture = fileURLToPath(new URL('./fixtures/cli-discovery.mjs', import.meta.url));
const fixturesDir = dirname(fixture);
const environment = { ...process.env, XDG_DATA_HOME: fixturesDir };
const fixtureOptions = { executable, executableArgs: [fixture], environment };
/** Select a Claude auth/billing scenario for the offline fixture. */
const claudeEnv = (mode: string) => ({ ...environment, FERRY_CLAUDE_FIXTURE: mode });

it('derives a stable, non-secret account key', () => {
  const key = deriveCliAccountKey('codex-cli', 'dev@example.com');
  expect(key).toMatch(/^codex-cli:[a-f0-9]{24}$/);
  expect(deriveCliAccountKey('codex-cli', 'dev@example.com')).toBe(key);
  expect(deriveCliAccountKey('codex-cli', 'other@example.com')).not.toBe(key);
  expect(deriveCliAccountKey('codex-cli', null)).toBeNull();
});

it('parses the OpenCode auth store without exposing provider secrets', () => {
  const records = parseOpencodeAuthStore({
    'opencode-go': { type: 'api', key: 'secret-value' },
    empty: {},
  });
  expect(records).toEqual([
    { providerId: 'opencode-go', type: 'api', key: 'secret-value' },
    { providerId: 'empty', type: null, key: null },
  ]);
});

it('parses verbose OpenCode models with reasoning variants', () => {
  const blocks = parseOpencodeModelsVerbose(
    'opencode-go/deepseek-v4.1-flash\n{\n  "id": "deepseek-v4.1-flash",\n  "variants": { "high": { "reasoningEffort": "high" } }\n}\n',
  );
  expect(blocks).toHaveLength(1);
  expect(blocks[0]?.providerId).toBe('opencode-go');
  expect(blocks[0]?.id).toBe('deepseek-v4.1-flash');
});

it('parses Claude auth status JSON defensively', () => {
  const status = parseClaudeAuthStatus(
    '{"loggedIn":true,"email":"dev@example.com","orgId":"org-1","apiKeySource":"project"}',
  );
  expect(status).toMatchObject({
    loggedIn: true,
    email: 'dev@example.com',
    orgId: 'org-1',
    apiKeySource: 'project',
  });
  expect(parseClaudeAuthStatus('not json')).toBeNull();
  expect(parseClaudeAuthStatus('{}')).toBeNull();
  expect(parseClaudeAuthStatus('{"loggedIn":"true"}')).toBeNull();
});

it('discovers Codex with reported ultra effort and multi-bucket limits', async () => {
  const connection = await discoverCliConnection('codex-cli', {
    ...fixtureOptions,
    version: '0.0.0-fixture',
  });
  expect(() => CliConnectionSchema.parse(connection)).not.toThrow();
  expect(connection.id).toBe('codex-cli');
  expect(connection.providerId).toBe('codex-cli');
  expect(connection.install.installed).toBe(true);
  expect(connection.account.state).toBe('signed_in');
  expect(connection.account.key).toMatch(/^codex-cli:[a-f0-9]{24}$/);
  expect(connection.account.plan).toBe('pro');
  const model = connection.models[0];
  expect(model?.ref).toBe('codex-cli/gpt-5.1-codex');
  // Reported effort tokens are preserved verbatim, including `ultra`.
  expect(model?.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'ultra']);
  expect(model?.defaultEffort).toBe('medium');
  expect(model?.speeds).toContain('fast');
  expect(connection.usage.state).toBe('available');
  expect(connection.usage.accountKey).toMatch(/^codex-cli:[a-f0-9]{24}$/);
  // Prefer the genuine multi-bucket view over the legacy single bucket.
  const codexBucket = connection.usage.windows.find((window) => window.id === 'codex:primary');
  expect(codexBucket?.used).toBe(65);
  expect(connection.usage.windows.some((window) => window.id === 'codex:secondary')).toBe(true);
  const mini = connection.usage.windows.find((window) => window.id === 'codex-mini:primary');
  expect(mini?.used).toBe(130);
  expect(mini?.utilization).toBeCloseTo(1.3);
  expect(mini?.remaining).toBe(0);
}, 30_000);

it('discovers Claude models and limits through structured control', async () => {
  const connection = await discoverCliConnection('claude-code-cli', {
    ...fixtureOptions,
    version: '0.0.0-fixture',
  });
  expect(() => CliConnectionSchema.parse(connection)).not.toThrow();
  expect(connection.account.state).toBe('signed_in');
  expect(connection.account.label).toBe('dev@example.com');
  expect(connection.account.plan).toBe('Claude Pro');
  expect(connection.account.key).toMatch(/^claude-code-cli:[a-f0-9]{24}$/);
  const opus = connection.models.find((model) => model.ref.endsWith('claude-opus-5-5'));
  expect(opus).toBeDefined();
  expect(opus?.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  expect(opus?.speeds).toContain('fast');
  // Proven native subscription auth (claude.ai + firstParty + Pro) is included capacity.
  expect(opus?.billing).toBe('included_subscription');
  expect(connection.usage.state).toBe('available');
  expect(connection.usage.source).toBe('claude control get_usage');
  const fiveHour = connection.usage.windows.find((window) => window.id === 'five_hour');
  expect(fiveHour?.used).toBe(65);
  expect(connection.usage.windows.some((window) => window.id === 'seven_day')).toBe(true);
}, 30_000);

it('treats a successful initialize as discovery, not authentication', async () => {
  const signedOut = await discoverCliConnection('claude-code-cli', {
    ...fixtureOptions,
    version: '0.0.0-fixture',
    environment: claudeEnv('signed-out'),
  });
  // Models are still discovered, but the account is authoritatively signed out and unverified.
  expect(signedOut.models.length).toBeGreaterThan(0);
  expect(signedOut.account.state).toBe('signed_out');
  expect(signedOut.account.key).toBeNull();
  expect(signedOut.verify.state).toBe('unverified');

  const noAccount = await discoverCliConnection('claude-code-cli', {
    ...fixtureOptions,
    version: '0.0.0-fixture',
    environment: claudeEnv('account-null'),
  });
  // Initialize succeeded but returned no account, and auth status was unavailable: unknown, not in.
  expect(noAccount.models.length).toBeGreaterThan(0);
  expect(noAccount.account.state).toBe('unknown');
  expect(noAccount.account.key).toBeNull();
}, 30_000);

it('reports a checked-out account through usage refresh and keeps null when unavailable', async () => {
  const options = { executable, executableArgs: [fixture] };
  const signedIn = await discoverCliConnection('claude-code-cli', {
    ...fixtureOptions,
    version: '0.0.0-fixture',
  });
  const loggedOut = await discoverCliUsage(signedIn, {
    ...options,
    environment: claudeEnv('signed-out'),
  });
  expect(loggedOut.account?.state).toBe('signed_out');
  expect(loggedOut.account?.key).toBeNull();
  expect(loggedOut.account?.label).toBeNull();

  // Both probes failed entirely: no evidence, so the caller must not treat it as a logout.
  const unavailable = await discoverCliUsage(signedIn, {
    ...options,
    environment: claudeEnv('unavailable'),
  });
  expect(unavailable.account).toBeNull();

  // Initialize succeeded but carried no account and auth status was unavailable: unknown, not out.
  const inconclusive = await discoverCliUsage(signedIn, {
    ...options,
    environment: claudeEnv('account-null'),
  });
  expect(inconclusive.account?.state).toBe('unknown');
  expect(inconclusive.account?.key).toBeNull();
}, 30_000);

it('hashes distinct users in the same organization to different account keys', async () => {
  const options = { ...fixtureOptions, version: '0.0.0-fixture' };
  const userA = await discoverCliConnection('claude-code-cli', {
    ...options,
    environment: claudeEnv('org-a'),
  });
  const userB = await discoverCliConnection('claude-code-cli', {
    ...options,
    environment: claudeEnv('org-b'),
  });
  expect(userA.account.key).toMatch(/^claude-code-cli:[a-f0-9]{24}$/);
  expect(userA.account.key).not.toBe(userB.account.key);
}, 30_000);

it('classifies API-key and cloud-provider sources as metered despite stale Pro metadata', async () => {
  const options = { ...fixtureOptions, version: '0.0.0-fixture' };
  for (const mode of ['api-key', 'bedrock', 'vertex']) {
    const connection = await discoverCliConnection('claude-code-cli', {
      ...options,
      environment: claudeEnv(mode),
    });
    const opus = connection.models.find((model) => model.ref.endsWith('claude-opus-5-5'));
    expect(opus?.billing, mode).toBe('metered');
  }
}, 30_000);

it('discovers OpenCode models and identifies the OpenCode Go credential', async () => {
  const connection = await discoverCliConnection('opencode-cli', {
    ...fixtureOptions,
    version: '1.18.35',
  });
  expect(() => CliConnectionSchema.parse(connection)).not.toThrow();
  expect(connection.account.state).toBe('signed_in');
  expect(connection.account.label).toBe('OpenCode Go');
  expect(connection.account.key).toMatch(/^opencode-cli:[a-f0-9]{24}$/);
  const model = connection.models.find(
    (entry) => entry.ref === 'opencode-cli/opencode-go/deepseek-v4.1-flash',
  );
  expect(model?.upstreamProvider).toBe('opencode-go');
  expect(model?.efforts).toEqual(['low', 'high', 'max']);
  // OpenCode Go is included subscription capacity, never reported as a free route.
  expect(model?.billing).toBe('included_subscription');
  // Budget-only native variants (no reasoningEffort value) are discovered by their map key.
  const budget = connection.models.find((entry) => entry.ref.endsWith('qwen-thinking'));
  expect(budget?.efforts).toEqual(['thinking']);
}, 30_000);

it('refreshes usage from a cached connection without re-detecting install', async () => {
  const usageOptions = { executable, executableArgs: [fixture], environment };
  const codex = await discoverCliConnection('codex-cli', {
    ...fixtureOptions,
    version: '0.0.0-fixture',
  });
  const codexRefresh = await discoverCliUsage(codex, usageOptions);
  expect(codexRefresh.usage.connectionId).toBe('codex-cli');
  expect(codexRefresh.usage.state).toBe('available');
  expect(codexRefresh.usage.windows.length).toBeGreaterThanOrEqual(2);
  // Authoritative account evidence travels with the usage probe.
  expect(codexRefresh.account?.state).toBe('signed_in');

  const claude = await discoverCliConnection('claude-code-cli', {
    ...fixtureOptions,
    version: '0.0.0-fixture',
  });
  const claudeRefresh = await discoverCliUsage(claude, usageOptions);
  expect(claudeRefresh.usage.state).toBe('available');
  expect(claudeRefresh.usage.windows.some((window) => window.id === 'five_hour')).toBe(true);
  expect(claudeRefresh.account?.state).toBe('signed_in');

  const opencode = await discoverCliConnection('opencode-cli', {
    ...fixtureOptions,
    version: '1.18.35',
  });
  const opencodeRefresh = await discoverCliUsage(opencode, usageOptions);
  expect(opencodeRefresh.usage.state).toBe('unavailable');
  expect(opencodeRefresh.account).toBeNull();
}, 30_000);
