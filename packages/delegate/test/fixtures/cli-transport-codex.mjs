/* Offline fake Codex app-server (headerless NDJSON JSON-RPC) for cli-transport tests. */
import { spawn } from 'node:child_process';
import { renameSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const scenario = process.env.FERRY_CODEX_SCENARIO ?? 'text';
const recordPath = process.env.FERRY_CODEX_RECORD;
const requestedModel = process.env.FERRY_CODEX_MODEL ?? 'gpt-6.1-sol';
const stageFile = process.env.FERRY_CODEX_STAGE_FILE;
function markStage(value) {
  if (stageFile) writeFileSync(stageFile, value, 'utf8');
}

// Readiness IPC: record the private working directory so cancellation tests can verify temp cleanup.
if (process.env.FERRY_CODEX_CWD_FILE) {
  writeFileSync(process.env.FERRY_CODEX_CWD_FILE, process.cwd(), 'utf8');
}
// Hold scenarios keep a stubborn grandchild alive so tests can prove the whole tree is terminated.
if (scenario.startsWith('hold')) {
  const child = spawn(
    process.execPath,
    ['-e', 'process.on("SIGTERM",()=>{}); setInterval(() => {}, 1000)'],
    { stdio: 'ignore', windowsHide: true },
  );
  if (process.env.FERRY_CODEX_CHILD_PID)
    writeFileSync(process.env.FERRY_CODEX_CHILD_PID, String(child.pid));
  setInterval(() => {}, 1000);
  if (scenario === 'holdstartup') markStage('holdstartup');
}

const record = { argv: process.argv.slice(1), requests: [], responses: [] };
function flush() {
  if (!recordPath) return;
  const temporary = `${recordPath}.tmp`;
  writeFileSync(temporary, JSON.stringify(record), 'utf8');
  renameSync(temporary, recordPath);
}

let nextServerId = 900;
const pendingResponses = new Map();
function awaitResponse(id) {
  return new Promise((resolve) => pendingResponses.set(id, resolve));
}

function send(frame) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`);
}
function reply(id, result) {
  send({ id, result });
}
function notify(method, params) {
  send({ method, params });
}
/** Write one JSON line split inside a multibyte character to exercise incremental UTF-8 decoding. */
function notifySplit(method, params) {
  return new Promise((resolve) => {
    const line = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`, 'utf8');
    const emoji = Buffer.from('😀', 'utf8');
    const at = line.indexOf(emoji);
    const split = at >= 0 ? at + 2 : Math.floor(line.length / 2);
    process.stdout.write(line.subarray(0, split));
    setTimeout(() => {
      process.stdout.write(line.subarray(split));
      resolve();
    }, 5);
  });
}
function serverRequest(method, params) {
  const id = nextServerId++;
  send({ id, method, params });
  return id;
}

const textUsage = {
  inputTokens: 10,
  outputTokens: 5,
  cachedInputTokens: 2,
  reasoningOutputTokens: 1,
  totalTokens: 18,
};

async function runTurn(turn, threadId) {
  const turnId = turn.id;
  switch (scenario) {
    case 'text': {
      notify('item/agentMessage/delta', { delta: 'Hello ', itemId: 'i1', threadId, turnId });
      notify('item/agentMessage/delta', { delta: 'world', itemId: 'i1', threadId, turnId });
      notify('thread/tokenUsage/updated', {
        threadId,
        turnId,
        tokenUsage: { last: textUsage, total: textUsage },
      });
      notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed', items: [] } });
      break;
    }
    case 'nousage': {
      notify('item/agentMessage/delta', { delta: 'No usage here', itemId: 'i1', threadId, turnId });
      notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed', items: [] } });
      break;
    }
    case 'zero': {
      const zero = {
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
      };
      notify('item/agentMessage/delta', { delta: 'Zero usage', itemId: 'i1', threadId, turnId });
      notify('thread/tokenUsage/updated', {
        threadId,
        turnId,
        tokenUsage: { last: zero, total: zero },
      });
      notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed', items: [] } });
      break;
    }
    case 'cumulative': {
      const first = {
        inputTokens: 5,
        outputTokens: 2,
        cachedInputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 7,
      };
      const second = {
        inputTokens: 50,
        outputTokens: 20,
        cachedInputTokens: 3,
        reasoningOutputTokens: 4,
        totalTokens: 77,
      };
      notify('item/agentMessage/delta', { delta: 'Cumulative', itemId: 'i1', threadId, turnId });
      notify('thread/tokenUsage/updated', {
        threadId,
        turnId,
        tokenUsage: { last: first, total: first },
      });
      notify('thread/tokenUsage/updated', {
        threadId,
        turnId,
        tokenUsage: { last: second, total: second },
      });
      notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed', items: [] } });
      break;
    }
    case 'partial': {
      const partial = { inputTokens: 12, outputTokens: 7, totalTokens: 19 };
      notify('item/agentMessage/delta', { delta: 'Partial usage', itemId: 'i1', threadId, turnId });
      notify('thread/tokenUsage/updated', {
        threadId,
        turnId,
        tokenUsage: { last: partial, total: partial },
      });
      notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed', items: [] } });
      break;
    }
    case 'split': {
      await notifySplit('item/agentMessage/delta', { delta: '😀', itemId: 'i1', threadId, turnId });
      notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed', items: [] } });
      break;
    }
    case 'tool': {
      notify('item/agentMessage/delta', {
        delta: 'Calling caller tool',
        itemId: 'i1',
        threadId,
        turnId,
      });
      serverRequest('item/tool/call', {
        callId: 'call_fixture_1',
        tool: 'ferry_tool_0',
        arguments: { path: 'marker.txt' },
        threadId,
        turnId,
      });
      break;
    }
    case 'hostile': {
      notify('item/agentMessage/delta', {
        delta: 'Trying native tool',
        itemId: 'i1',
        threadId,
        turnId,
      });
      serverRequest('execCommandApproval', {
        callId: 'native_1',
        command: ['rm', '-rf', '/'],
        cwd: 'C:/',
      });
      await awaitResponse(nextServerId - 1);
      serverRequest('item/tool/call', {
        callId: 'call_hostile_1',
        tool: 'ferry_tool_0',
        arguments: { path: 'marker.txt' },
        threadId,
        turnId,
      });
      break;
    }
    case 'exhausted':
      notify('turn/completed', {
        threadId,
        turn: {
          id: turnId,
          status: 'failed',
          items: [],
          error: { message: 'usage limit reached', codexErrorInfo: 'usageLimitExceeded' },
        },
      });
      break;
    case 'temporary':
      notify('turn/completed', {
        threadId,
        turn: {
          id: turnId,
          status: 'failed',
          items: [],
          error: { message: 'rate limit exceeded', codexErrorInfo: 'rateLimitExceeded' },
        },
      });
      break;
    case 'auth':
      notify('turn/completed', {
        threadId,
        turn: {
          id: turnId,
          status: 'failed',
          items: [],
          error: { message: 'unauthorized', codexErrorInfo: 'unauthorized' },
        },
      });
      break;
    case 'model':
      notify('turn/completed', {
        threadId,
        turn: {
          id: turnId,
          status: 'failed',
          items: [],
          error: { message: 'unknown model', codexErrorInfo: 'badRequest' },
        },
      });
      break;
    case 'reroute':
      notify('model/rerouted', { threadId, turnId, model: 'gpt-other-sol' });
      notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed', items: [] } });
      break;
    case 'exit':
      process.exit(3);
      break;
    case 'hold':
    case 'holdstream':
    case 'holdtool': {
      // Grandchild is already spawned at startup for hold* scenarios.
      if (scenario === 'holdstream') {
        notify('item/agentMessage/delta', { delta: 'partial', itemId: 'i1', threadId, turnId });
      }
      if (scenario === 'holdtool') {
        serverRequest('execCommandApproval', {
          callId: 'native_hold',
          command: ['rm', '-rf', '/'],
          cwd: 'C:/',
        });
      }
      markStage(scenario);
      setInterval(() => {}, 1000);
      break;
    }
    default:
      notify('item/agentMessage/delta', { delta: 'default', itemId: 'i1', threadId, turnId });
      notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed', items: [] } });
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
  if (frame.id !== undefined && frame.method === undefined) {
    // Response to a server request we sent.
    record.responses.push({ id: frame.id, frame });
    flush();
    const resolve = pendingResponses.get(frame.id);
    if (resolve) {
      pendingResponses.delete(frame.id);
      resolve(frame);
    }
    return;
  }
  if (frame.method === 'initialize') {
    record.requests.push({ method: 'initialize', params: frame.params });
    flush();
    // Cancel-during-startup: never answer initialize; the process stays alive for the abort test.
    if (scenario === 'holdstartup') return;
    const userAgent =
      scenario === 'oldversion'
        ? 'Codex Desktop/0.161.0 (Windows 10.0.26300; x86_64) dumb (ferry_readonly_probe; 0.9.0)'
        : scenario === 'unknownversion'
          ? 'Codex Desktop (Windows) dumb'
          : 'Codex Desktop/0.162.1 (Windows 10.0.26300; x86_64) dumb (ferry_readonly_probe; 0.9.0)';
    reply(frame.id, {
      userAgent,
      codexHome: process.cwd(),
      platformFamily: 'windows',
      platformOs: 'windows',
    });
    return;
  }
  if (frame.method === 'account/read') {
    record.requests.push({ method: 'account/read', params: frame.params });
    flush();
    const accounts = {
      default: { type: 'chatgpt', email: 'fixture@example.com', planType: 'plus' },
      accountnull: null,
      apikey: { type: 'apiKey' },
      identitymismatch: { type: 'chatgpt', email: 'other@example.com', planType: 'plus' },
      planmismatch: { type: 'chatgpt', email: 'fixture@example.com', planType: 'pro' },
    };
    const account = Object.prototype.hasOwnProperty.call(accounts, scenario)
      ? accounts[scenario]
      : accounts.default;
    reply(frame.id, { requiresOpenaiAuth: true, account });
    return;
  }
  if (frame.method === 'account/rateLimits/read') {
    record.requests.push({ method: 'account/rateLimits/read', params: frame.params });
    flush();
    reply(frame.id, {
      rateLimits: {
        limitId: 'codex',
        primary: { usedPercent: 65, windowDurationMins: 300, resetsAt: 1791938267 },
        secondary: { usedPercent: 11, windowDurationMins: 10080, resetsAt: 1792487618 },
      },
    });
    return;
  }
  if (frame.method === 'model/list') {
    record.requests.push({ method: 'model/list', params: frame.params });
    flush();
    reply(frame.id, {
      data: [
        {
          id: requestedModel,
          model: requestedModel,
          displayName: 'Fixture Model',
          defaultReasoningEffort: 'low',
          supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'low' }],
          // A default tier is listed first on purpose; a fast resolver must match by id/name, not [0].
          serviceTiers: [
            { id: 'standard', name: 'Standard', description: 'default' },
            { id: 'priority', name: 'Fast', description: '2x speed' },
          ],
        },
      ],
    });
    return;
  }
  if (frame.method === 'thread/start') {
    record.requests.push({ method: 'thread/start', params: frame.params });
    flush();
    reply(frame.id, {
      thread: { id: 'thr_fixture', model: frame.params?.model ?? requestedModel, ephemeral: true },
      model: frame.params?.model ?? requestedModel,
      modelProvider: 'openai',
      cwd: frame.params?.cwd ?? process.cwd(),
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandbox: { type: 'readOnly' },
    });
    return;
  }
  if (frame.method === 'thread/inject_items') {
    record.requests.push({ method: 'thread/inject_items', params: frame.params });
    flush();
    if (scenario === 'noinject') {
      send({ id: frame.id, error: { code: -32601, message: 'Method not found' } });
    } else {
      reply(frame.id, {});
    }
    return;
  }
  if (frame.method === 'turn/start') {
    record.requests.push({ method: 'turn/start', params: frame.params });
    flush();
    const turn = { id: 'turn_fixture', status: 'inProgress', items: [] };
    reply(frame.id, { turn });
    setImmediate(() => {
      void runTurn(turn, 'thr_fixture');
    });
    return;
  }
  if (frame.method === 'turn/interrupt') {
    reply(frame.id, {});
    return;
  }
  if (frame.id !== undefined) reply(frame.id, {});
});

lines.on('close', () => {
  flush();
  if (scenario !== 'hold') setTimeout(() => process.exit(0), 10);
});
