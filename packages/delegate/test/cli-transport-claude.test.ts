import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  CliConnection,
  CliModelCapabilities,
  CliUsageSnapshot,
  ModelRef,
} from '@ferry/shared';
import {
  CliTransportError,
  runClaudeCodeCli,
  type CliConversationMessage,
  type CliTransportInput,
} from '../src/cli-transport/index.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/cli-transport-claude.mjs', import.meta.url));
const MODEL = 'claude-fixture-model';
const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ferry-cli-claude-test-'));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })),
  );
});

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

interface ClaudeRecord {
  argv: string[];
  mcp: Record<string, unknown> | null;
  settings: Record<string, unknown> | null;
  frames: { type: string; subtype?: string; message?: Record<string, unknown> }[];
  responses: Record<string, unknown>[];
  mcpTools: string[] | null;
}

async function readRecord(path: string): Promise<ClaudeRecord> {
  return JSON.parse(await readFile(path, 'utf8')) as ClaudeRecord;
}

function claudeModel(overrides: Partial<CliModelCapabilities> = {}): CliModelCapabilities {
  return {
    ref: 'claude-code-cli/claude-fixture-model' as ModelRef,
    connectionId: 'claude-code-cli',
    providerId: 'claude-code-cli',
    upstreamId: MODEL,
    upstreamProvider: 'anthropic',
    name: 'Fixture Model',
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
    speeds: ['standard'],
    defaultSpeed: 'standard',
    modalities: ['text'],
    toolCalling: true,
    billing: 'included_subscription',
    hidden: false,
    ...overrides,
  };
}

function claudeConnection(model: CliModelCapabilities): CliConnection {
  return {
    id: 'claude-code-cli',
    kind: 'claude-code-cli',
    providerId: 'claude-code-cli',
    upstreamLabel: 'Claude',
    install: { installed: true, executable: 'claude', version: '2.1.296', installHint: '' },
    account: {
      state: 'signed_in',
      key: 'claude-code-cli:abcdef012345',
      label: 'fixture@example.com',
      plan: 'Claude Pro',
    },
    verify: { state: 'verified', modelRef: null, checkedAt: null, message: null },
    surfaces: { native: true, gateway: false },
    models: [model],
    usage: {
      connectionId: 'claude-code-cli',
      accountKey: null,
      state: 'unavailable',
      source: 'test',
      observedAt: null,
      staleAt: null,
      windows: [],
      note: null,
    },
    lastChecked: null,
    discoveryMessage: null,
  };
}

interface ClaudeRunOptions extends Partial<CliTransportInput> {
  scenario: string;
  record: string;
  childPidFile?: string;
  authStatus?: string;
}

function makeInput(options: ClaudeRunOptions): CliTransportInput {
  const model = options.model ?? claudeModel();
  const connection = options.connection ?? claudeConnection(model);
  const input: CliTransportInput = {
    connection,
    model,
    options: options.options ?? { effort: null, speed: 'standard' },
    messages: options.messages ?? [{ role: 'user', content: 'Say hello' }],
    tools: options.tools ?? [],
    signal: options.signal ?? new AbortController().signal,
    environment: {
      ...process.env,
      FERRY_CLAUDE_SCENARIO: options.scenario,
      FERRY_CLAUDE_RECORD: options.record,
      FERRY_CLAUDE_MODEL: model.upstreamId,
      ...(options.childPidFile ? { FERRY_CLAUDE_CHILD_PID: options.childPidFile } : {}),
      ...(options.authStatus ? { FERRY_CLAUDE_AUTH_STATUS: options.authStatus } : {}),
    },
    executable: process.execPath,
    executableArgs: [FIXTURE],
    timeoutMs: 20_000,
  };
  if (options.onText) input.onText = options.onText;
  if (options.onProgress) input.onProgress = options.onProgress;
  if (options.onUsageSnapshot) input.onUsageSnapshot = options.onUsageSnapshot;
  return input;
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for condition');
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('runClaudeCodeCli', () => {
  it(
    'streams text, reports usage, forces standard speed and isolates flags',
    { timeout: 30_000 },
    async () => {
      const dir = await tempRoot();
      const recordPath = join(dir, 'record.json');
      const chunks: string[] = [];
      const snapshots: CliUsageSnapshot[] = [];
      const result = await runClaudeCodeCli(
        makeInput({
          scenario: 'text',
          record: recordPath,
          onText: (text) => chunks.push(text),
          onUsageSnapshot: (snapshot) => snapshots.push(snapshot),
        }),
      );

      expect(result.text).toBe('Hello');
      expect(chunks.join('')).toBe('Hello');
      expect(result.toolCalls).toEqual([]);
      expect(result.usage).toEqual({
        inputTokens: 12,
        outputTokens: 5,
        cachedTokens: 2,
        reasoningTokens: null,
      });
      expect(result.responseModel).toBe(MODEL);

      const record = await readRecord(recordPath);
      expect(record.argv).toContain('--strict-mcp-config');
      expect(record.argv).toContain('--disable-slash-commands');
      expect(record.argv).toContain('--no-session-persistence');
      expect(record.argv).toContain('--include-partial-messages');
      const modelIndex = record.argv.indexOf('--model');
      expect(record.argv[modelIndex + 1]).toBe(MODEL);
      expect(record.settings?.fastMode).toBe(false);
      expect(record.settings?.fastModePerSessionOptIn).toBe(true);
      expect(record.settings?.disableAllHooks).toBe(true);
      expect((asRecord(record.settings?.permissions).deny as string[]).includes('Bash')).toBe(true);
      expect(record.mcp).toEqual({ mcpServers: {} });
      expect(snapshots[0]?.windows[0]?.utilization).toBeCloseTo(0.65);
    },
  );

  it(
    'hands off caller tools through the MCP bridge and continues from history',
    { timeout: 30_000 },
    async () => {
      const dir = await tempRoot();
      const toolRecord = join(dir, 'tool.json');
      const tools = [
        { name: 'read_file', description: 'Read a file', parameters: { type: 'object' } },
      ];
      const first = await runClaudeCodeCli(
        makeInput({
          scenario: 'tool',
          record: toolRecord,
          tools,
          messages: [{ role: 'user', content: 'Read marker.txt' }],
        }),
      );
      expect(first.toolCalls).toEqual([
        { id: 'toolu_fixture_1', name: 'read_file', arguments: { path: 'marker.txt' } },
      ]);

      const toolRecordData = await readRecord(toolRecord);
      expect(toolRecordData.mcpTools).toContain('tool_0');
      const server = asRecord(asRecord(toolRecordData.mcp?.mcpServers).ferry_tools);
      expect(String(asRecord(server.headers).Authorization).startsWith('Bearer ')).toBe(true);

      const continueRecord = join(dir, 'continue.json');
      const history: CliConversationMessage[] = [
        { role: 'user', content: 'Read marker.txt' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'toolu_fixture_1',
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":"marker.txt"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'toolu_fixture_1', content: 'file contents' },
      ];
      await runClaudeCodeCli(
        makeInput({ scenario: 'text', record: continueRecord, tools, messages: history }),
      );
      const record = await readRecord(continueRecord);
      const assistant = record.frames.find((frame) => frame.type === 'assistant');
      const toolUse = asRecord((assistant?.message?.content as unknown[])[0]);
      expect(toolUse.type).toBe('tool_use');
      expect(toolUse.id).toBe('toolu_fixture_1');
      expect(toolUse.name).toBe('mcp__ferry_tools__tool_0');
      const toolResult = record.frames.find((frame) => {
        const content = frame.message?.content;
        return (
          frame.type === 'user' &&
          Array.isArray(content) &&
          asRecord(content[0]).type === 'tool_result'
        );
      });
      expect(asRecord((toolResult?.message?.content as unknown[])[0]).tool_use_id).toBe(
        'toolu_fixture_1',
      );
      expect(asRecord((toolResult?.message?.content as unknown[])[0]).content).toBe(
        'file contents',
      );
    },
  );

  it('denies native tool requests and never executes them', { timeout: 30_000 }, async () => {
    const dir = await tempRoot();
    const recordPath = join(dir, 'hostile.json');
    const error = await runClaudeCodeCli(
      makeInput({ scenario: 'hostile', record: recordPath }),
    ).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(CliTransportError);
    expect((error as CliTransportError).kind).toBe('unsupported_capability');
    const record = await readRecord(recordPath);
    const denial = record.responses.find((response) => 'error' in asRecord(response.response));
    expect(denial).toBeDefined();
    expect(asRecord(asRecord(denial).response).subtype).toBe('error');
  });

  it.each([
    ['exhausted', 'exhausted_capacity'],
    ['temporary', 'temporary_rate_limit'],
    ['auth', 'authentication'],
    ['unavailable', 'unavailable_model'],
  ])('maps %s failures to %s', { timeout: 30_000 }, async (scenario, kind) => {
    const dir = await tempRoot();
    const error = await runClaudeCodeCli(
      makeInput({ scenario, record: join(dir, `${scenario}.json`) }),
    ).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(CliTransportError);
    expect((error as CliTransportError).kind).toBe(kind);
  });

  it('reports missing usage as null and keeps reported zeroes', { timeout: 30_000 }, async () => {
    const dir = await tempRoot();
    const missing = await runClaudeCodeCli(
      makeInput({ scenario: 'nousage', record: join(dir, 'nousage.json') }),
    );
    expect(missing.usage).toEqual({
      inputTokens: null,
      outputTokens: null,
      cachedTokens: null,
      reasoningTokens: null,
    });
    const zero = await runClaudeCodeCli(
      makeInput({ scenario: 'zero', record: join(dir, 'zero.json') }),
    );
    expect(zero.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: null,
      reasoningTokens: null,
    });
  });

  it(
    'normalizes Claude input total, cache and reasoning dimensions',
    { timeout: 30_000 },
    async () => {
      const dir = await tempRoot();
      const full = await runClaudeCodeCli(
        makeInput({ scenario: 'usagefull', record: join(dir, 'usagefull.json') }),
      );
      expect(full.usage).toEqual({
        inputTokens: 4028,
        outputTokens: 5,
        cachedTokens: 3000,
        reasoningTokens: 7,
      });

      const partial = await runClaudeCodeCli(
        makeInput({ scenario: 'partial', record: join(dir, 'partial.json') }),
      );
      expect(partial.usage).toEqual({
        inputTokens: 9,
        outputTokens: 3,
        cachedTokens: null,
        reasoningTokens: null,
      });

      const cumulative = await runClaudeCodeCli(
        makeInput({ scenario: 'cumulative', record: join(dir, 'cumulative.json') }),
      );
      expect(cumulative.usage).toEqual({
        inputTokens: 3028,
        outputTokens: 5,
        cachedTokens: 3000,
        reasoningTokens: null,
      });
    },
  );

  it('decodes a multibyte character split across stdout chunks', { timeout: 30_000 }, async () => {
    const dir = await tempRoot();
    const result = await runClaudeCodeCli(
      makeInput({ scenario: 'split', record: join(dir, 'split.json') }),
    );
    expect(result.text).toBe('😀');
  });

  it.each([
    ['logged out', '{"loggedIn":false,"apiProvider":"firstParty"}'],
    ['cloud provider', '{"loggedIn":true,"apiProvider":"bedrock","subscriptionType":"pro"}'],
    [
      'api key source',
      '{"loggedIn":true,"apiProvider":"firstParty","apiKeySource":"ANTHROPIC_API_KEY","subscriptionType":"pro"}',
    ],
    ['plan change', '{"loggedIn":true,"apiProvider":"firstParty","subscriptionType":"team"}'],
  ])(
    'rejects %s from auth status before prompting',
    { timeout: 30_000 },
    async (_label, authStatus) => {
      const dir = await tempRoot();
      const recordPath = join(dir, 'auth.json');
      const error = await runClaudeCodeCli(
        makeInput({ scenario: 'text', record: recordPath, authStatus }),
      ).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(CliTransportError);
      expect((error as CliTransportError).kind).toBe('authentication');
      expect(existsSync(recordPath)).toBe(false);
    },
  );

  it('normalizes streamed rate-limit fractions to utilization', { timeout: 30_000 }, async () => {
    const dir = await tempRoot();
    const snapshots: CliUsageSnapshot[] = [];
    await runClaudeCodeCli(
      makeInput({
        scenario: 'ratelimit',
        record: join(dir, 'ratelimit.json'),
        onUsageSnapshot: (snapshot) => snapshots.push(snapshot),
      }),
    );
    expect(snapshots.length).toBeGreaterThan(0);
    expect(snapshots.at(-1)?.windows[0]?.utilization).toBeCloseTo(0.42);
  });

  it('enables fast mode only when requested and advertised', { timeout: 30_000 }, async () => {
    const dir = await tempRoot();
    const fastRecord = join(dir, 'fast.json');
    const model = claudeModel({ speeds: ['standard', 'fast'] });
    await runClaudeCodeCli(
      makeInput({
        scenario: 'text',
        record: fastRecord,
        model,
        options: { effort: null, speed: 'fast' },
      }),
    );
    const record = await readRecord(fastRecord);
    expect(record.settings?.fastMode).toBe(true);

    const notAdvertised = claudeModel({ speeds: ['standard'] });
    const notFastRecord = join(dir, 'notfast.json');
    const error = await runClaudeCodeCli(
      makeInput({
        scenario: 'text',
        record: notFastRecord,
        model: notAdvertised,
        options: { effort: null, speed: 'fast' },
      }),
    ).catch((value: unknown) => value);
    expect((error as CliTransportError).kind).toBe('unsupported_capability');
    expect(existsSync(notFastRecord)).toBe(false);
  });

  it(
    'cancels during a held turn and leaves no orphan child process',
    { timeout: 30_000 },
    async () => {
      const dir = await tempRoot();
      const recordPath = join(dir, 'hold.json');
      const pidPath = join(dir, 'child.pid');
      const controller = new AbortController();
      const pending = runClaudeCodeCli(
        makeInput({
          scenario: 'hold',
          record: recordPath,
          signal: controller.signal,
          childPidFile: pidPath,
        }),
      );
      await waitFor(() => existsSync(pidPath));
      const childPid = Number((await readFile(pidPath, 'utf8')).trim());
      expect(isAlive(childPid)).toBe(true);
      controller.abort();
      const error = await pending.catch((value: unknown) => value);
      expect(error).toBeInstanceOf(CliTransportError);
      expect((error as CliTransportError).kind).toBe('cancelled');
      await waitFor(() => !isAlive(childPid));
    },
  );

  it('keeps concurrent contexts isolated', { timeout: 30_000 }, async () => {
    const dir = await tempRoot();
    const recordA = join(dir, 'a.json');
    const recordB = join(dir, 'b.json');
    const [a, b] = await Promise.all([
      runClaudeCodeCli(makeInput({ scenario: 'text', record: recordA })),
      runClaudeCodeCli(makeInput({ scenario: 'ratelimit', record: recordB })),
    ]);
    expect(a.text).toBe('Hello');
    expect(b.text).toBe('Limited');
    const recordARecord = await readRecord(recordA);
    const recordBRecord = await readRecord(recordB);
    expect(recordARecord.argv.join(' ')).not.toBe(recordBRecord.argv.join(' '));
  });
});
