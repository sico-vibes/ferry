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
  runCodexCli,
  type CliConversationMessage,
  type CliTransportInput,
} from '../src/cli-transport/index.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/cli-transport-codex.mjs', import.meta.url));
const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ferry-cli-codex-test-'));
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

interface RecordFile {
  argv: string[];
  requests: { method: string; params: Record<string, unknown> }[];
  responses: { id: number; frame: Record<string, unknown> }[];
  cwd?: string;
  pwd?: string | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

async function readRecord(path: string): Promise<RecordFile> {
  return JSON.parse(await readFile(path, 'utf8')) as RecordFile;
}

function requestOf(record: RecordFile, method: string): Record<string, unknown> {
  const found = record.requests.find((entry) => entry.method === method);
  if (!found) throw new Error(`fixture never received ${method}`);
  return found.params;
}

function codexModel(overrides: Partial<CliModelCapabilities> = {}): CliModelCapabilities {
  return {
    ref: 'codex-cli/gpt-6.1-sol' as ModelRef,
    connectionId: 'codex-cli',
    providerId: 'codex-cli',
    upstreamId: 'gpt-6.1-sol',
    upstreamProvider: 'openai',
    name: 'GPT-6.1-Sol',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'low',
    speeds: ['standard'],
    defaultSpeed: 'standard',
    modalities: ['text'],
    toolCalling: true,
    billing: 'included_subscription',
    hidden: false,
    ...overrides,
  };
}

function codexConnection(model: CliModelCapabilities): CliConnection {
  return {
    id: 'codex-cli',
    kind: 'codex-cli',
    providerId: 'codex-cli',
    upstreamLabel: 'ChatGPT',
    install: { installed: true, executable: 'codex', version: '1.162.1', installHint: '' },
    account: {
      state: 'signed_in',
      key: 'codex-cli:abcdef012345',
      label: 'fixture@example.com',
      plan: 'plus',
    },
    verify: { state: 'verified', modelRef: null, checkedAt: null, message: null },
    surfaces: { native: true, gateway: false },
    models: [model],
    usage: {
      connectionId: 'codex-cli',
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

interface CodexRunOptions extends Partial<CliTransportInput> {
  scenario: string;
  record: string;
  childPidFile?: string;
  cwdFile?: string;
  stageFile?: string;
  /** Configured native MCP servers the fake `config/read` reports (non-activating metadata). */
  mcpConfig?: Record<string, unknown>;
  /** Configured plugins (and any plugin MCP servers) the fake `config/read` reports. */
  pluginConfig?: Record<string, unknown>;
  /** Effective plugin availability the fake `plugin/list` reports (verification step). */
  pluginList?: unknown;
  /** Native hooks state the fake `config/read` reports (verification step). */
  hookConfig?: unknown;
  /** Native notify command the fake `config/read` reports (verification step). */
  notifyList?: unknown;
  /** Probe-mode: file the fake probe writes its argv to. */
  probeArgsFile?: string;
  /** Probe-mode: hold `config/read` forever so tests can cancel/time out mid-probe. */
  probeHoldConfig?: boolean;
  /** Probe-mode: file the fake probe writes its private cwd to (temp-cleanup assertion). */
  probeCwdFile?: string;
  /** Probe-mode: file the fake probe writes when it receives `config/read`. */
  probeReachedFile?: string;
  /** Inherited PWD that the transport must not forward to the child. */
  pwd?: string;
}

function makeInput(options: CodexRunOptions): CliTransportInput {
  const model = options.model ?? codexModel();
  const connection = options.connection ?? codexConnection(model);
  const input: CliTransportInput = {
    connection,
    model,
    options: options.options ?? { effort: null, speed: 'standard' },
    messages: options.messages ?? [{ role: 'user', content: 'Say hello' }],
    tools: options.tools ?? [],
    signal: options.signal ?? new AbortController().signal,
    environment: {
      ...process.env,
      ...(options.pwd ? { PWD: options.pwd } : {}),
      ...(options.mcpConfig ? { FERRY_CODEX_MCP_CONFIG: JSON.stringify(options.mcpConfig) } : {}),
      ...(options.pluginConfig
        ? { FERRY_CODEX_PLUGIN_CONFIG: JSON.stringify(options.pluginConfig) }
        : {}),
      ...(options.pluginList
        ? { FERRY_CODEX_PLUGIN_LIST: JSON.stringify(options.pluginList) }
        : {}),
      ...(options.hookConfig
        ? { FERRY_CODEX_HOOK_CONFIG: JSON.stringify(options.hookConfig) }
        : {}),
      ...(options.notifyList
        ? { FERRY_CODEX_NOTIFY_LIST: JSON.stringify(options.notifyList) }
        : {}),
      ...(options.probeArgsFile ? { FERRY_CODEX_PROBE_ARGS_FILE: options.probeArgsFile } : {}),
      ...(options.probeHoldConfig ? { FERRY_CODEX_PROBE_HOLD: 'config' } : {}),
      ...(options.probeCwdFile ? { FERRY_CODEX_PROBE_CWD_FILE: options.probeCwdFile } : {}),
      ...(options.probeReachedFile
        ? { FERRY_CODEX_PROBE_REACHED_FILE: options.probeReachedFile }
        : {}),
      FERRY_CODEX_SCENARIO: options.scenario,
      FERRY_CODEX_RECORD: options.record,
      FERRY_CODEX_MODEL: model.upstreamId,
      ...(options.childPidFile ? { FERRY_CODEX_CHILD_PID: options.childPidFile } : {}),
      ...(options.cwdFile ? { FERRY_CODEX_CWD_FILE: options.cwdFile } : {}),
      ...(options.stageFile ? { FERRY_CODEX_STAGE_FILE: options.stageFile } : {}),
    },
    executable: process.execPath,
    executableArgs: [FIXTURE],
    timeoutMs: options.timeoutMs ?? 20_000,
  };
  if (options.onText) input.onText = options.onText;
  if (options.onProgress) input.onProgress = options.onProgress;
  if (options.onUsageSnapshot) input.onUsageSnapshot = options.onUsageSnapshot;
  if (options.fastServiceTierId) input.fastServiceTierId = options.fastServiceTierId;
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

describe('runCodexCli', () => {
  it(
    'streams text, reports per-turn usage and sends isolated thread config',
    { timeout: 30_000 },
    async () => {
      const dir = await tempRoot();
      const recordPath = join(dir, 'record.json');
      const chunks: string[] = [];
      let progress = 0;
      const result = await runCodexCli(
        makeInput({
          scenario: 'text',
          record: recordPath,
          onText: (text) => chunks.push(text),
          onProgress: () => {
            progress += 1;
          },
        }),
      );

      expect(result.text).toBe('Hello world');
      expect(chunks.join('')).toBe('Hello world');
      expect(progress).toBeGreaterThan(0);
      expect(result.toolCalls).toEqual([]);
      expect(result.usage).toEqual({
        inputTokens: 10,
        outputTokens: 5,
        cachedTokens: 2,
        reasoningTokens: 1,
      });
      expect(result.responseModel).toBe('gpt-6.1-sol');

      const record = await readRecord(recordPath);
      expect(record.argv).toContain('app-server');
      const thread = requestOf(record, 'thread/start');
      expect(thread.ephemeral).toBe(true);
      expect(thread.environments).toEqual([]);
      expect(thread.sandbox).toBe('read-only');
      expect(thread.approvalPolicy).toBe('never');
      expect(thread.allowProviderModelFallback).toBe(false);
      expect(asRecord(thread.config).mcp_servers).toEqual({});
      expect(asRecord(thread.config).web_search).toBe('disabled');
      expect(asRecord(thread.config).notify).toEqual([]);
      expect(asRecord(asRecord(thread.config).features)).toEqual({
        shell_tool: false,
        unified_exec: false,
        unified_exec_tty: false,
        shell_snapshot: false,
        view_image: false,
        sleep_tool: false,
        multi_agent: false,
        code_mode: false,
        code_mode_host: false,
        plugins: false,
        hooks: false,
        codex_hooks: false,
      });
      expect(asRecord(thread.config).project_doc_max_bytes).toBe(0);
      expect(asRecord(thread.config).include_permissions_instructions).toBe(false);
      expect(asRecord(thread.config).include_apps_instructions).toBe(false);
      expect(asRecord(thread.config).include_collaboration_mode_instructions).toBe(false);
      expect(asRecord(thread.config).include_environment_context).toBe(false);
      expect(String(thread.baseInstructions)).toContain('NO host capabilities');
      // Standard speed is pinned explicitly so the user's global priority/Fast is never inherited.
      expect(thread.serviceTier).toBe('default');
      const turn = requestOf(record, 'turn/start');
      expect(turn.serviceTierForTurn).toBe('default');
      expect(turn.input).toEqual([{ type: 'text', text: 'Say hello' }]);
      expect(record.requests.some((entry) => entry.method === 'model/list')).toBe(false);
    },
  );

  it(
    'sends compact caller-owned instructions and retains caller system/developer',
    { timeout: 30_000 },
    async () => {
      const dir = await tempRoot();
      const recordPath = join(dir, 'instructions.json');
      const messages: CliConversationMessage[] = [
        { role: 'system', content: 'CALLER_SYSTEM_MARK' },
        { role: 'developer', content: 'CALLER_DEV_MARK' },
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'hi' },
      ];
      await runCodexCli(makeInput({ scenario: 'text', record: recordPath, messages }));
      const record = await readRecord(recordPath);
      const thread = requestOf(record, 'thread/start');
      const base = String(thread.baseInstructions);
      expect(base).toContain('NO host capabilities');
      expect(base).toContain('CALLER_SYSTEM_MARK');
      expect(thread.developerInstructions).toBe('CALLER_DEV_MARK');
      // Caller system/developer must not be duplicated into the injected item history.
      const injected = asRecord(requestOf(record, 'thread/inject_items'));
      const items = injected.items as unknown[];
      expect(items.some((item) => asRecord(item).role === 'system')).toBe(false);
      expect(items.some((item) => asRecord(item).role === 'developer')).toBe(false);
      expect(
        items.some((item) => asRecord(item).type === 'message' && asRecord(item).role === 'user'),
      ).toBe(true);
    },
  );

  it(
    'hands off caller tools by real name and continues from real history',
    { timeout: 30_000 },
    async () => {
      const dir = await tempRoot();
      const toolRecord = join(dir, 'tool.json');
      const tools = [
        { name: 'read_file', description: 'Read a file', parameters: { type: 'object' } },
      ];
      const first = await runCodexCli(
        makeInput({
          scenario: 'tool',
          record: toolRecord,
          tools,
          messages: [{ role: 'user', content: 'Read marker.txt' }],
        }),
      );
      expect(first.toolCalls).toEqual([
        { id: 'call_fixture_1', name: 'read_file', arguments: { path: 'marker.txt' } },
      ]);
      expect(first.text).toBe('Calling caller tool');

      const continueRecord = join(dir, 'continue.json');
      const history: CliConversationMessage[] = [
        { role: 'user', content: 'Read marker.txt' },
        {
          role: 'assistant',
          content: 'Calling caller tool',
          tool_calls: [
            {
              id: 'call_fixture_1',
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":"marker.txt"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_fixture_1', content: 'file contents' },
      ];
      const second = await runCodexCli(
        makeInput({ scenario: 'text', record: continueRecord, tools, messages: history }),
      );
      expect(second.text).toBe('Hello world');

      const record = await readRecord(continueRecord);
      const injected = asRecord(requestOf(record, 'thread/inject_items'));
      const items = injected.items as unknown[];
      expect(
        items.find(
          (item) =>
            asRecord(item).type === 'function_call' && asRecord(item).call_id === 'call_fixture_1',
        ),
      ).toBeDefined();
      const output = items.find(
        (item) =>
          asRecord(item).type === 'function_call_output' &&
          asRecord(item).call_id === 'call_fixture_1',
      );
      expect(asRecord(output).output).toBe('file contents');
      const call = items.find((item) => asRecord(item).type === 'function_call');
      expect(asRecord(call).name).toBe('ferry_tool_0');
      const turn = requestOf(record, 'turn/start');
      expect(turn.input).toEqual([]);
      expect(asRecord(turn.toolOutput)).toEqual({ name: 'ferry_tool_0', output: 'file contents' });
    },
  );

  it(
    'denies hostile native requests but still hands off caller tools',
    { timeout: 30_000 },
    async () => {
      const dir = await tempRoot();
      const recordPath = join(dir, 'hostile.json');
      const result = await runCodexCli(
        makeInput({
          scenario: 'hostile',
          record: recordPath,
          tools: [{ name: 'read_file', parameters: { type: 'object' } }],
        }),
      );
      expect(result.toolCalls).toEqual([
        { id: 'call_hostile_1', name: 'read_file', arguments: { path: 'marker.txt' } },
      ]);
      const record = await readRecord(recordPath);
      const denied = record.responses.find(
        (response) => asRecord(response.frame).error !== undefined,
      );
      expect(denied).toBeDefined();
      expect(asRecord(asRecord(denied?.frame).error).message).toContain('denies native');
    },
  );

  it(
    'accepts the real 0.162.1 user agent but rejects old and unknown versions',
    { timeout: 30_000 },
    async () => {
      const dir = await tempRoot();
      const accepted = await runCodexCli(
        makeInput({ scenario: 'text', record: join(dir, 'accepted.json') }),
      );
      expect(accepted.text).toBe('Hello world');

      const oldError = await runCodexCli(
        makeInput({ scenario: 'oldversion', record: join(dir, 'old.json') }),
      ).catch((value: unknown) => value);
      expect((oldError as CliTransportError).kind).toBe('unsupported_capability');
      expect((oldError as CliTransportError).message).toContain('0.161.0');

      const unknownError = await runCodexCli(
        makeInput({ scenario: 'unknownversion', record: join(dir, 'unknown.json') }),
      ).catch((value: unknown) => value);
      expect((unknownError as CliTransportError).kind).toBe('unsupported_capability');
      expect((unknownError as CliTransportError).message).toContain('Could not determine');

      const record = await readRecord(join(dir, 'unknown.json'));
      expect(record.requests.some((entry) => entry.method === 'thread/start')).toBe(false);
    },
  );

  it.each([
    ['exhausted', 'exhausted_capacity'],
    ['temporary', 'temporary_rate_limit'],
    ['auth', 'authentication'],
    ['model', 'unavailable_model'],
  ])('maps %s failures to %s', { timeout: 30_000 }, async (scenario, kind) => {
    const dir = await tempRoot();
    const recordPath = join(dir, `${scenario}.json`);
    const error = await runCodexCli(makeInput({ scenario, record: recordPath })).catch(
      (value: unknown) => value,
    );
    expect(error).toBeInstanceOf(CliTransportError);
    expect((error as CliTransportError).kind).toBe(kind);
  });

  it.each(['apikey', 'identitymismatch', 'planmismatch', 'accountnull'])(
    'rejects a contradictory native account (%s) before prompting',
    { timeout: 30_000 },
    async (scenario) => {
      const dir = await tempRoot();
      const recordPath = join(dir, `${scenario}.json`);
      const error = await runCodexCli(makeInput({ scenario, record: recordPath })).catch(
        (value: unknown) => value,
      );
      expect(error).toBeInstanceOf(CliTransportError);
      expect((error as CliTransportError).kind).toBe('authentication');
      const record = await readRecord(recordPath);
      expect(record.requests.some((entry) => entry.method === 'turn/start')).toBe(false);
    },
  );

  it(
    'reports missing usage as null but keeps reported zeroes and final totals',
    { timeout: 30_000 },
    async () => {
      const dir = await tempRoot();
      const missing = await runCodexCli(
        makeInput({ scenario: 'nousage', record: join(dir, 'missing.json') }),
      );
      expect(missing.usage).toEqual({
        inputTokens: null,
        outputTokens: null,
        cachedTokens: null,
        reasoningTokens: null,
      });

      const zero = await runCodexCli(
        makeInput({ scenario: 'zero', record: join(dir, 'zero.json') }),
      );
      expect(zero.usage).toEqual({
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        reasoningTokens: 0,
      });

      const cumulative = await runCodexCli(
        makeInput({ scenario: 'cumulative', record: join(dir, 'cumulative.json') }),
      );
      expect(cumulative.usage).toEqual({
        inputTokens: 50,
        outputTokens: 20,
        cachedTokens: 3,
        reasoningTokens: 4,
      });

      const partial = await runCodexCli(
        makeInput({ scenario: 'partial', record: join(dir, 'partial.json') }),
      );
      expect(partial.usage).toEqual({
        inputTokens: 12,
        outputTokens: 7,
        cachedTokens: null,
        reasoningTokens: null,
      });
    },
  );

  it('decodes a multibyte character split across stdout chunks', { timeout: 30_000 }, async () => {
    const dir = await tempRoot();
    const result = await runCodexCli(
      makeInput({ scenario: 'split', record: join(dir, 'split.json') }),
    );
    expect(result.text).toBe('😀');
  });

  it('refuses silent model substitution', { timeout: 30_000 }, async () => {
    const dir = await tempRoot();
    const recordPath = join(dir, 'reroute.json');
    const error = await runCodexCli(makeInput({ scenario: 'reroute', record: recordPath })).catch(
      (value: unknown) => value,
    );
    expect(error).toBeInstanceOf(CliTransportError);
    expect((error as CliTransportError).kind).toBe('provider_error');
    expect((error as CliTransportError).message).toContain('gpt-other-sol');
  });

  it(
    'uses the advertised fast tier id and rejects unadvertised speed/effort',
    { timeout: 30_000 },
    async () => {
      const dir = await tempRoot();
      const recordPath = join(dir, 'fast.json');
      const model = codexModel({ speeds: ['standard', 'fast'] });
      const result = await runCodexCli(
        makeInput({
          scenario: 'text',
          record: recordPath,
          model,
          options: { effort: 'high', speed: 'fast' },
        }),
      );
      expect(result.text).toBe('Hello world');
      const record = await readRecord(recordPath);
      expect(record.requests.some((entry) => entry.method === 'model/list')).toBe(true);
      // Fast uses the CLI-advertised tier at both thread and turn level (never an inherited default).
      expect(requestOf(record, 'thread/start').serviceTier).toBe('priority');
      const turn = requestOf(record, 'turn/start');
      expect(turn.serviceTierForTurn).toBe('priority');
      expect(turn.effort).toBe('high');

      const cachedRecordPath = join(dir, 'fastcached.json');
      await runCodexCli(
        makeInput({
          scenario: 'text',
          record: cachedRecordPath,
          model,
          options: { effort: null, speed: 'fast' },
          fastServiceTierId: 'priority',
        }),
      );
      const cachedRecord = await readRecord(cachedRecordPath);
      expect(cachedRecord.requests.some((entry) => entry.method === 'model/list')).toBe(false);
      expect(requestOf(cachedRecord, 'turn/start').serviceTierForTurn).toBe('priority');

      const notFast = codexModel({ speeds: ['standard'] });
      const fastError = await runCodexCli(
        makeInput({
          scenario: 'text',
          record: join(dir, 'notfast.json'),
          model: notFast,
          options: { effort: null, speed: 'fast' },
        }),
      ).catch((value: unknown) => value);
      expect((fastError as CliTransportError).kind).toBe('unsupported_capability');

      const ultraError = await runCodexCli(
        makeInput({
          scenario: 'text',
          record: join(dir, 'ultra.json'),
          options: { effort: 'ultra', speed: 'standard' },
        }),
      ).catch((value: unknown) => value);
      expect((ultraError as CliTransportError).kind).toBe('unsupported_capability');
      expect(existsSync(join(dir, 'ultra.json'))).toBe(false);
      expect(existsSync(join(dir, 'notfast.json'))).toBe(false);
    },
  );

  it(
    'pins the advertised default effort and rejects an ultra default before prompting',
    { timeout: 30_000 },
    async () => {
      const dir = await tempRoot();
      const recordPath = join(dir, 'effort.json');
      const model = codexModel({ defaultEffort: 'low' });
      await runCodexCli(makeInput({ scenario: 'text', record: recordPath, model }));
      expect(requestOf(await readRecord(recordPath), 'turn/start').effort).toBe('low');

      const ultraPath = join(dir, 'ultra.json');
      const ultra = codexModel({
        defaultEffort: 'ultra',
        efforts: ['low', 'medium', 'high', 'ultra'],
      });
      const error = await runCodexCli(
        makeInput({ scenario: 'text', record: ultraPath, model: ultra }),
      ).catch((value: unknown) => value);
      expect((error as CliTransportError).kind).toBe('unsupported_capability');
      expect(existsSync(ultraPath)).toBe(false);
    },
  );

  it('emits an account rate-limit usage snapshot', { timeout: 30_000 }, async () => {
    const dir = await tempRoot();
    const snapshots: CliUsageSnapshot[] = [];
    await runCodexCli(
      makeInput({
        scenario: 'text',
        record: join(dir, 'usage.json'),
        onUsageSnapshot: (snapshot) => snapshots.push(snapshot),
      }),
    );
    expect(snapshots.length).toBeGreaterThan(0);
    const window = snapshots[0]?.windows[0];
    expect(window?.metric).toBe('percent');
    expect(window?.utilization).toBeCloseTo(0.65);
  });

  it(
    'rejects a connection that reports a signed-out account before dispatch',
    { timeout: 30_000 },
    async () => {
      const dir = await tempRoot();
      const model = codexModel();
      const connection = codexConnection(model);
      connection.account.state = 'signed_out';
      const recordPath = join(dir, 'signedout.json');
      const error = await runCodexCli(
        makeInput({ scenario: 'text', record: recordPath, connection, model }),
      ).catch((value: unknown) => value);
      expect((error as CliTransportError).kind).toBe('authentication');
      expect(existsSync(recordPath)).toBe(false);
    },
  );

  it.each(['hold', 'holdstartup', 'holdstream', 'holdtool'])(
    'cancels during %s and terminates the tree and temp dir',
    { timeout: 30_000 },
    async (scenario) => {
      const dir = await tempRoot();
      const recordPath = join(dir, `${scenario}.json`);
      const pidPath = join(dir, `${scenario}.pid`);
      const cwdPath = join(dir, `${scenario}.cwd`);
      const stagePath = join(dir, `${scenario}.stage`);
      const controller = new AbortController();
      const pending = runCodexCli(
        makeInput({
          scenario,
          record: recordPath,
          signal: controller.signal,
          childPidFile: pidPath,
          cwdFile: cwdPath,
          stageFile: stagePath,
        }),
      );
      await waitFor(() => existsSync(pidPath) && existsSync(cwdPath) && existsSync(stagePath));
      expect((await readFile(stagePath, 'utf8')).trim()).toBe(scenario);
      const childPid = Number((await readFile(pidPath, 'utf8')).trim());
      const privateCwd = (await readFile(cwdPath, 'utf8')).trim();
      expect(isAlive(childPid)).toBe(true);
      controller.abort();
      const error = await pending.catch((value: unknown) => value);
      expect(error).toBeInstanceOf(CliTransportError);
      expect((error as CliTransportError).kind).toBe('cancelled');
      await waitFor(() => !isAlive(childPid));
      // Cleanup happens before the promise settles, so the private temp dir must be gone.
      expect(existsSync(privateCwd)).toBe(false);
    },
  );

  it('keeps concurrent contexts isolated', { timeout: 30_000 }, async () => {
    const dir = await tempRoot();
    const recordA = join(dir, 'a.json');
    const recordB = join(dir, 'b.json');
    const [a, b] = await Promise.all([
      runCodexCli(makeInput({ scenario: 'text', record: recordA })),
      runCodexCli(makeInput({ scenario: 'cumulative', record: recordB })),
    ]);
    expect(a.text).toBe('Hello world');
    expect(b.text).toBe('Cumulative');
    const recordARecord = await readRecord(recordA);
    const recordBRecord = await readRecord(recordB);
    const threadA = requestOf(recordARecord, 'thread/start');
    const threadB = requestOf(recordBRecord, 'thread/start');
    expect(threadA.cwd).not.toBe(threadB.cwd);
  });

  it(
    'disables native MCP servers and plugin sources at startup and in the private thread',
    { timeout: 30_000 },
    async () => {
      const dir = await tempRoot();
      const recordPath = join(dir, 'mcp.json');
      const probeArgsPath = join(dir, 'probe.args');
      await runCodexCli(
        makeInput({
          scenario: 'text',
          record: recordPath,
          mcpConfig: { inline_server: {}, table_server: {} },
          pluginConfig: {
            'sentinel@local': { enabled: true, mcp_servers: { 'srv.one': { enabled: true } } },
          },
          probeArgsFile: probeArgsPath,
        }),
      );

      const record = await readRecord(recordPath);
      // The activating status call is gone; enumeration uses the non-activating config probe.
      expect(record.requests.some((entry) => entry.method === 'mcpServerStatus/list')).toBe(false);
      // The config probe also runs with the blanket native hook/notify/plugin disables.
      const probeArgs = (JSON.parse(await readFile(probeArgsPath, 'utf8')) as string[]).join(' ');
      expect(probeArgs).toContain('-c features.hooks=false');
      expect(probeArgs).toContain('-c notify=[]');
      expect(probeArgs).toContain('-c features.plugins=false');
      // Generation startup flags: blankets plus bare-name MCP disables.
      const argv = record.argv.join(' ');
      expect(argv).toContain('-c features.plugins=false');
      expect(argv).toContain('-c features.hooks=false');
      expect(argv).toContain('-c features.codex_hooks=false');
      expect(argv).toContain('-c notify=[]');
      expect(argv).toContain('-c mcp_servers.inline_server.enabled=false');
      expect(argv).toContain('-c mcp_servers.table_server.enabled=false');

      const thread = requestOf(record, 'thread/start');
      const config = asRecord(thread.config);
      // Per-name/plugin disable maps at thread level (never an empty map, which the app server
      // merge-applies without clearing inherited servers).
      expect(config.mcp_servers).toEqual({
        inline_server: { enabled: false },
        table_server: { enabled: false },
      });
      expect(config.plugins).toEqual({
        'sentinel@local': {
          enabled: false,
          mcp_servers: { 'srv.one': { enabled: false } },
        },
      });
      expect(config.web_search).toBe('disabled');
      expect(config.notify).toEqual([]);
      const features = asRecord(config.features);
      expect(features.plugins).toBe(false);
      expect(features.hooks).toBe(false);
      expect(features.codex_hooks).toBe(false);
      expect(features.shell_tool).toBe(false);
      expect(features.unified_exec).toBe(false);
      expect(features.unified_exec_tty).toBe(false);
      expect(features.view_image).toBe(false);
      expect(features.sleep_tool).toBe(false);
      expect(features.code_mode_host).toBe(false);

      // A second invocation re-reads the effective config: a newly added name is accounted for and
      // the previous set is not cached/stale.
      const updatedPath = join(dir, 'mcp-updated.json');
      await runCodexCli(
        makeInput({
          scenario: 'text',
          record: updatedPath,
          mcpConfig: { brand_new_server: {} },
        }),
      );
      const updatedRecord = await readRecord(updatedPath);
      expect(updatedRecord.argv.join(' ')).toContain(
        '-c mcp_servers.brand_new_server.enabled=false',
      );
      const updatedThread = requestOf(updatedRecord, 'thread/start');
      expect(asRecord(updatedThread.config).mcp_servers).toEqual({
        brand_new_server: { enabled: false },
      });
    },
  );

  it(
    'fails closed before the thread when an enabled plugin still advertises',
    { timeout: 30_000 },
    async () => {
      const dir = await tempRoot();
      const recordPath = join(dir, 'plugin-failclosed.json');
      const error = await runCodexCli(
        makeInput({
          scenario: 'text',
          record: recordPath,
          pluginConfig: { 'sentinel@local': { enabled: true } },
          pluginList: {
            marketplaces: [{ plugins: [{ id: 'sentinel@local', enabled: true }] }],
          },
        }),
      ).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(CliTransportError);
      expect((error as CliTransportError).kind).toBe('unsupported_capability');
      expect((error as CliTransportError).message).toContain('sentinel@local');
      const record = await readRecord(recordPath);
      expect(record.requests.some((entry) => entry.method === 'thread/start')).toBe(false);
    },
  );

  it.each([
    [
      'admin-managed hooks',
      { hookConfig: { managed_dir: 'C:/managed-hooks' } },
      /admin-managed lifecycle hooks/,
    ],
    [
      'a surviving native notify command',
      { notifyList: ['node', '-e', 'require("fs")'] },
      /native notify command/,
    ],
  ])(
    'fails closed before the thread when %s is present',
    { timeout: 30_000 },
    async (_label, overrides, message) => {
      const dir = await tempRoot();
      const recordPath = join(dir, 'hook-failclosed.json');
      const error = await runCodexCli(
        makeInput({ scenario: 'text', record: recordPath, ...overrides }),
      ).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(CliTransportError);
      expect((error as CliTransportError).kind).toBe('unsupported_capability');
      expect((error as CliTransportError).message).toMatch(message);
      const record = await readRecord(recordPath);
      expect(record.requests.some((entry) => entry.method === 'thread/start')).toBe(false);
    },
  );

  it(
    'pins the private PWD so an inherited project PWD cannot leak',
    { timeout: 30_000 },
    async () => {
      const dir = await tempRoot();
      const recordPath = join(dir, 'pwd.json');
      const leaked = join(dir, 'orchestrator-repo');
      await runCodexCli(makeInput({ scenario: 'text', record: recordPath, pwd: leaked }));
      const record = await readRecord(recordPath);
      expect(record.pwd).toBe(record.cwd);
      expect(record.pwd).not.toBe(leaked);
    },
  );

  it('denies a native tool call that is not caller-provided', { timeout: 30_000 }, async () => {
    const dir = await tempRoot();
    const recordPath = join(dir, 'nativetool.json');
    const result = await runCodexCli(makeInput({ scenario: 'nativetool', record: recordPath }));
    expect(result.toolCalls).toEqual([]);
    const record = await readRecord(recordPath);
    const denied = record.responses.find(
      (response) => asRecord(response.frame).error !== undefined,
    );
    expect(denied).toBeDefined();
    expect(asRecord(asRecord(denied?.frame).error).message).toContain('denies native');
  });

  it(
    'cancels during the config probe with a typed cancelled error and no temp or generation leak',
    { timeout: 30_000 },
    async () => {
      const dir = await tempRoot();
      const recordPath = join(dir, 'probe-cancel.json');
      const probeCwdFile = join(dir, 'probe.cwd');
      const reachedFile = join(dir, 'probe.reached');
      const controller = new AbortController();
      const pending = runCodexCli(
        makeInput({
          scenario: 'text',
          record: recordPath,
          signal: controller.signal,
          probeHoldConfig: true,
          probeCwdFile,
          probeReachedFile: reachedFile,
        }),
      );
      // Wait until the probe has spawned and is blocked on config/read, then cancel.
      await waitFor(() => existsSync(reachedFile) && existsSync(probeCwdFile));
      const probeCwd = (await readFile(probeCwdFile, 'utf8')).trim();
      controller.abort();
      const error = await pending.catch((value: unknown) => value);
      expect(error).toBeInstanceOf(CliTransportError);
      expect((error as CliTransportError).kind).toBe('cancelled');
      // No generation process was spawned (the record file is only written by the generation run).
      expect(existsSync(recordPath)).toBe(false);
      // The probe's private temp dir was removed.
      expect(existsSync(probeCwd)).toBe(false);
    },
  );

  it(
    'times out during the config probe, then a later request still works',
    { timeout: 30_000 },
    async () => {
      const dir = await tempRoot();
      const timedOutRecord = join(dir, 'probe-timeout.json');
      const error = await runCodexCli(
        makeInput({
          scenario: 'text',
          record: timedOutRecord,
          timeoutMs: 500,
          probeHoldConfig: true,
          probeReachedFile: join(dir, 'probe.timeout.reached'),
        }),
      ).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(CliTransportError);
      expect((error as CliTransportError).kind).toBe('timeout');
      expect(existsSync(timedOutRecord)).toBe(false);

      // A subsequent request is unaffected (the probe timeout did not wedge anything).
      const okRecord = join(dir, 'after-timeout.json');
      const result = await runCodexCli(makeInput({ scenario: 'text', record: okRecord }));
      expect(result.text).toBe('Hello world');
    },
  );
});
