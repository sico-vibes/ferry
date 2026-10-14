/* Offline fake Claude Code stream-json/control CLI for cli-transport tests. */
import { spawn } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const scenario = process.env.FERRY_CLAUDE_SCENARIO ?? 'text';
const recordPath = process.env.FERRY_CLAUDE_RECORD;
const requestedModel = process.env.FERRY_CLAUDE_MODEL ?? 'claude-fixture-model';

const argv = process.argv.slice(1);
function argValue(flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

// Read-only auth-status probe: print bounded JSON and exit. Do this before touching the record so
// the preflight process never races the generation process on the record file.
if (argv.includes('auth') && argv.includes('status')) {
  const status =
    process.env.FERRY_CLAUDE_AUTH_STATUS ??
    '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"pro"}';
  process.stdout.write(`${status}\n`, () => process.exit(0));
} else {
  // Readiness IPC: record the private working directory so cancellation tests can verify cleanup.
  if (process.env.FERRY_CLAUDE_CWD_FILE) {
    writeFileSync(process.env.FERRY_CLAUDE_CWD_FILE, process.cwd(), 'utf8');
  }
  const stageFile = process.env.FERRY_CLAUDE_STAGE_FILE;
  const markStage = (value) => {
    if (stageFile) writeFileSync(stageFile, value, 'utf8');
  };
  // Hold scenarios keep a stubborn grandchild alive so tests can prove tree termination.
  if (scenario.startsWith('hold')) {
    const child = spawn(
      process.execPath,
      ['-e', 'process.on("SIGTERM",()=>{}); setInterval(() => {}, 1000)'],
      { stdio: 'ignore', windowsHide: true },
    );
    if (process.env.FERRY_CLAUDE_CHILD_PID)
      writeFileSync(process.env.FERRY_CLAUDE_CHILD_PID, String(child.pid));
    setInterval(() => {}, 1000);
    if (scenario === 'holdstartup') markStage('holdstartup');
  }
  const mcpPath = argValue('--mcp-config');
  const settingsPath = argValue('--settings');
  const systemPromptPath = argValue('--system-prompt-file');
  const record = {
    argv,
    cwd: process.cwd(),
    pwd: process.env.PWD ?? null,
    mcp: null,
    settings: null,
    systemPrompt: null,
    frames: [],
    responses: [],
    mcpTools: null,
    // Real-CLI semantics: every user frame is a turn. Track them so a regression that sends
    // historical user frames (re-executing old turns) fails loudly instead of looking green.
    userMessages: [],
    assistantFrames: 0,
    multiUser: false,
    usedReplay: false,
  };
  try {
    record.systemPrompt = systemPromptPath ? readFileSync(systemPromptPath, 'utf8') : null;
  } catch {
    record.systemPrompt = null;
  }
  function flush() {
    if (!recordPath) return;
    const temporary = `${recordPath}.tmp`;
    writeFileSync(temporary, JSON.stringify(record), 'utf8');
    renameSync(temporary, recordPath);
  }
  try {
    record.mcp = mcpPath ? JSON.parse(readFileSync(mcpPath, 'utf8')) : null;
  } catch {
    record.mcp = null;
  }
  try {
    record.settings = settingsPath ? JSON.parse(readFileSync(settingsPath, 'utf8')) : null;
  } catch {
    record.settings = null;
  }
  flush();

  const send = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
  /** Write one JSON line split inside a multibyte character to exercise incremental UTF-8 decoding. */
  const sendSplit = (frame) =>
    new Promise((resolve) => {
      const line = Buffer.from(`${JSON.stringify(frame)}\n`, 'utf8');
      const at = line.indexOf(Buffer.from('😀', 'utf8'));
      const split = at >= 0 ? at + 2 : Math.floor(line.length / 2);
      process.stdout.write(line.subarray(0, split));
      setTimeout(() => {
        process.stdout.write(line.subarray(split));
        resolve();
      }, 5);
    });
  const controlResponse = (requestId, response) =>
    send({
      type: 'control_response',
      response: { request_id: requestId, subtype: 'success', response },
    });
  const controlError = (requestId, error) =>
    send({
      type: 'control_response',
      response: { request_id: requestId, subtype: 'error', error },
    });

  let nextRequestId = 500;
  const awaiting = new Map();
  function requestClient(subtype, payload) {
    const request_id = `fixture_${nextRequestId++}`;
    send({ type: 'control_request', request_id, request: { subtype, ...payload } });
    return new Promise((resolve) => awaiting.set(request_id, resolve));
  }

  async function inspectBridge() {
    const server = record.mcp?.mcpServers?.ferry_tools;
    if (!server?.url) return;
    try {
      const response = await fetch(server.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: server.headers.Authorization,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }).then((value) => value.json());
      record.mcpTools = (response.result?.tools ?? []).map((tool) => tool.name);
      flush();
    } catch {
      record.mcpTools = [];
      flush();
    }
  }

  async function runScenario() {
    switch (scenario) {
      case 'text': {
        send({
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } },
        });
        send({
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } },
        });
        send({
          type: 'assistant',
          message: {
            role: 'assistant',
            model: requestedModel,
            content: [{ type: 'text', text: 'Hello' }],
          },
        });
        send({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'Hello',
          session_id: 'sess_fixture',
          usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 },
        });
        break;
      }
      case 'tool': {
        await inspectBridge();
        send({
          type: 'assistant',
          message: {
            role: 'assistant',
            model: requestedModel,
            content: [
              {
                type: 'tool_use',
                id: 'toolu_fixture_1',
                name: 'mcp__ferry_tools__tool_0',
                input: { path: 'marker.txt' },
              },
            ],
          },
        });
        break;
      }
      case 'toolstream': {
        await inspectBridge();
        send({
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            index: 0,
            content_block: {
              type: 'tool_use',
              id: 'toolu_stream_1',
              name: 'mcp__ferry_tools__tool_0',
              input: {},
            },
          },
        });
        send({
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{"val' },
          },
        });
        send({
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: 'ue":"cli_' },
          },
        });
        await sendSplit({
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: 'safe😀_\\"quoted\\""}' },
          },
        });
        send({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
        // A complete assistant frame for the same id must not produce a duplicate call.
        send({
          type: 'assistant',
          message: {
            role: 'assistant',
            model: requestedModel,
            content: [
              {
                type: 'tool_use',
                id: 'toolu_stream_1',
                name: 'mcp__ferry_tools__tool_0',
                input: { value: 'cli_safe😀_"quoted"' },
              },
            ],
          },
        });
        break;
      }
      case 'toolpermission': {
        await inspectBridge();
        send({
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            index: 0,
            content_block: {
              type: 'tool_use',
              id: 'toolu_perm_1',
              name: 'mcp__ferry_tools__tool_0',
              input: {},
            },
          },
        });
        send({
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{"value":"partial' },
          },
        });
        // Permission arrives BEFORE content_block_stop with the COMPLETE input.
        await requestClient('can_use_tool', {
          tool_name: 'mcp__ferry_tools__tool_0',
          input: { value: 'permission_complete' },
          tool_use_id: 'toolu_perm_1',
        });
        break;
      }
      case 'hostile': {
        const response = await requestClient('can_use_tool', {
          tool_name: 'Bash',
          input: { command: 'rm -rf /' },
          tool_use_id: 'toolu_native',
        });
        record.responses.push(response);
        flush();
        send({
          type: 'assistant',
          message: {
            role: 'assistant',
            model: requestedModel,
            content: [
              {
                type: 'tool_use',
                id: 'toolu_native',
                name: 'Bash',
                input: { command: 'rm -rf /' },
              },
            ],
          },
        });
        break;
      }
      case 'exhausted':
        send({
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          result: 'usage limit reached',
          session_id: 's',
        });
        break;
      case 'temporary':
        send({
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          result: 'rate limit exceeded (429)',
          session_id: 's',
        });
        break;
      case 'auth':
        send({
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          result: 'not logged in',
          session_id: 's',
        });
        break;
      case 'nousage':
        send({
          type: 'assistant',
          message: {
            role: 'assistant',
            model: requestedModel,
            content: [{ type: 'text', text: 'No usage' }],
          },
        });
        send({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'No usage',
          session_id: 's',
        });
        break;
      case 'zero':
        send({
          type: 'assistant',
          message: {
            role: 'assistant',
            model: requestedModel,
            content: [{ type: 'text', text: 'Zero' }],
          },
        });
        send({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'Zero',
          session_id: 's',
          usage: { input_tokens: 0, output_tokens: 0 },
        });
        break;
      case 'usagefull':
        send({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'Full',
          session_id: 's',
          usage: {
            input_tokens: 28,
            cache_creation_input_tokens: 1000,
            cache_read_input_tokens: 3000,
            output_tokens: 5,
            output_tokens_details: { thinking_tokens: 7 },
          },
        });
        break;
      case 'partial':
        send({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'Partial',
          session_id: 's',
          usage: { input_tokens: 9, output_tokens: 3 },
        });
        break;
      case 'cumulative':
        send({
          type: 'assistant',
          message: {
            role: 'assistant',
            model: requestedModel,
            usage: { input_tokens: 5, output_tokens: 1 },
            content: [{ type: 'text', text: 'Cumulative' }],
          },
        });
        send({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'Cumulative',
          session_id: 's',
          usage: { input_tokens: 28, cache_read_input_tokens: 3000, output_tokens: 5 },
        });
        break;
      case 'split':
        await sendSplit({
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '😀' } },
        });
        send({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: '😀',
          session_id: 's',
        });
        break;
      case 'ratelimit':
        send({
          type: 'rate_limit_event',
          rate_limit_info: {
            utilization: 0.42,
            resetsAt: 1791938267,
            rateLimitType: 'five_hour',
            status: 'allowed',
          },
        });
        send({
          type: 'assistant',
          message: {
            role: 'assistant',
            model: requestedModel,
            content: [{ type: 'text', text: 'Limited' }],
          },
        });
        send({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'Limited',
          session_id: 's',
        });
        break;
      case 'exit':
        process.exit(4);
        break;
      case 'hold':
      case 'holdstream':
      case 'holdtool': {
        // Grandchild is already spawned at startup for hold* scenarios.
        if (scenario === 'holdstream') {
          send({
            type: 'stream_event',
            event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } },
          });
        }
        if (scenario === 'holdtool') {
          // A native tool permission request; Ferry must deny it and keep waiting.
          await requestClient('can_use_tool', {
            tool_name: 'Bash',
            input: { command: 'rm -rf /' },
            tool_use_id: 'toolu_hold_native',
          });
        }
        markStage(scenario);
        setInterval(() => {}, 1000);
        break;
      }
      default:
        send({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'default',
          session_id: 's',
        });
    }
  }

  const lines = createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    if (!line.trim()) return;
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      return;
    }
    if (frame.type === 'control_request') {
      const subtype = frame.request?.subtype;
      record.frames.push({ type: 'control_request', subtype });
      flush();
      if (subtype === 'initialize') {
        // Cancel-during-startup: never answer initialize; the process stays alive for the abort test.
        if (scenario === 'holdstartup') return;
        const models =
          scenario === 'unavailable'
            ? [{ value: 'other', resolvedModel: 'claude-other-fixture', displayName: 'Other' }]
            : [
                {
                  value: requestedModel,
                  resolvedModel: requestedModel,
                  displayName: 'Fixture Model',
                  supportsEffort: true,
                  supportedEffortLevels: ['low', 'medium', 'high'],
                  supportsFastMode: true,
                },
              ];
        controlResponse(frame.request_id, {
          models,
          account: {
            email: 'fixture@example.com',
            subscriptionType: 'Claude Pro',
            apiProvider: 'firstParty',
          },
          claude_code_version: '2.1.296',
          fast_mode_state: 'off',
          current_permission_mode: 'default',
        });
        return;
      }
      if (subtype === 'get_usage') {
        controlResponse(frame.request_id, {
          subscription_type: 'pro',
          rate_limits_available: true,
          rate_limits: {
            five_hour: { utilization: 65, resets_at: '2026-10-13T23:59:59.507631+00:00' },
            seven_day: { utilization: 62, resets_at: '2026-10-15T16:59:59.507650+00:00' },
          },
        });
        return;
      }
      controlError(frame.request_id, 'unsupported fixture control');
      return;
    }
    if (frame.type === 'control_response') {
      record.responses.push(frame);
      flush();
      const requestId = frame.response?.request_id;
      const resolve = awaiting.get(requestId);
      if (resolve) {
        awaiting.delete(requestId);
        resolve(frame);
      }
      return;
    }
    if (frame.type === 'user' || frame.type === 'assistant') {
      if (frame.isReplay === true) record.usedReplay = true;
      record.frames.push({
        type: frame.type,
        message: frame.message,
        isReplay: frame.isReplay === true,
      });
      if (frame.type === 'user') {
        const content = frame.message?.content;
        const text = Array.isArray(content)
          ? content
              .map((block) => (block && block.type === 'text' ? String(block.text ?? '') : ''))
              .join('')
          : String(content ?? '');
        record.userMessages.push(text);
        if (record.userMessages.length > 1) record.multiUser = true;
      } else {
        record.assistantFrames += 1;
      }
      flush();
      maybeStart(frame);
    }
  });

  let started = false;
  function maybeStart(frame) {
    if (started) return;
    // The CLI runs a turn for the first user frame; a second user frame means an old turn was
    // re-sent and would be re-executed, which we record as multiUser.
    if (frame.type !== 'user') return;
    started = true;
    // An awaited promise does not keep Node alive; hold the process open until the scenario finishes.
    const keepAlive = setInterval(() => {}, 1000);
    setTimeout(() => {
      void runScenario().finally(() => clearInterval(keepAlive));
    }, 0);
  }

  lines.on('close', () => {
    flush();
    if (!started) {
      started = true;
      const keepAlive = setInterval(() => {}, 1000);
      void runScenario().finally(() => clearInterval(keepAlive));
    }
  });
}
