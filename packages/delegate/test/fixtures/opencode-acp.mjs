// Offline OpenCode ACP fixture. Modes:
//   argv[0] === 'session' && argv[1] === 'delete' -> native session cleanup (exit 0)
//   otherwise -> headerless NDJSON ACP agent on stdio.
import { createInterface } from 'node:readline';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
if (args[0] === 'session' && args[1] === 'delete') {
  if (process.env.FERRY_OC_DELETE_MARKER)
    writeFileSync(process.env.FERRY_OC_DELETE_MARKER, args[2] ?? '');
  process.exit(0);
}

// Mirrors the genuine CLI's credential resolution (verified against OpenCode 1.18.35): a config
// `provider.<id>.options.apiKey` override wins over an auth-store `type: 'api'` key, which wins over
// `OPENCODE_API_KEY` (declared only for the two OpenCode providers). OAuth/unknown never yield a key.
function configProviderKey(provider) {
  try {
    const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? '{}');
    const key = config?.provider?.[provider]?.options?.apiKey;
    return typeof key === 'string' && key ? key : null;
  } catch {
    return null;
  }
}

function storeProviderKey(provider) {
  try {
    const dataHome = process.env.XDG_DATA_HOME ?? join(process.env.HOME ?? '', '.local', 'share');
    const path = join(dataHome, 'opencode', 'auth.json');
    if (!existsSync(path)) return null;
    const store = JSON.parse(readFileSync(path, 'utf8'));
    const record = store?.[provider];
    if (record?.type === 'api' && typeof record.key === 'string' && record.key) return record.key;
    return null;
  } catch {
    return null;
  }
}

function effectiveCredential(provider) {
  const configKey = configProviderKey(provider);
  if (configKey) return { key: configKey, source: 'config' };
  const storeKey = storeProviderKey(provider);
  if (storeKey) return { key: storeKey, source: 'store' };
  if (provider === 'opencode' || provider === 'opencode-go') {
    const envKey = process.env.OPENCODE_API_KEY;
    if (typeof envKey === 'string' && envKey) return { key: envKey, source: 'env' };
  }
  return { key: null, source: provider === 'opencode' ? 'public' : 'none' };
}

const models = [
  'opencode-go/deepseek-v4.1-flash',
  'opencode-go/deepseek-v4.1-pro',
  'opencode/big-pickle',
];
let currentModel = models[0];
let currentVariant = 'low';
let fast = false;
let sessionId = 'oc-acp-session';
let servers = [];

const lines = createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`);
const reply = (id, result) => send({ id, result });
const update = (payload) =>
  send({ method: 'session/update', params: { sessionId, update: payload } });
const text = (value) =>
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } });

function configOptions() {
  return [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: currentModel,
      options: models.map((value) => ({ value, name: value })),
    },
    {
      id: 'variant',
      name: 'Thinking variant',
      category: 'model_config',
      type: 'select',
      currentValue: currentVariant,
      options: ['low', 'medium', 'high', 'max'].map((value) => ({ value, name: value })),
    },
    {
      id: 'fast',
      name: 'Fast speed',
      category: 'model_config',
      type: 'boolean',
      currentValue: fast,
    },
  ];
}

const pending = new Map();
let nextId = 1000;
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    send({ id, method, params });
  });

for await (const line of lines) {
  const message = JSON.parse(line);
  if (!message.method) {
    pending.get(message.id)?.(message);
    pending.delete(message.id);
    continue;
  }
  void (async () => {
    switch (message.method) {
      case 'initialize':
        reply(message.id, {
          protocolVersion: 1,
          agentCapabilities: { providers: {} },
          authMethods: [{ id: 'login', name: 'Optional login' }],
        });
        break;
      case 'session/new':
        servers = message.params.mcpServers ?? [];
        reply(message.id, { sessionId, configOptions: configOptions() });
        break;
      case 'session/set_config_option': {
        const { configId, value } = message.params;
        if (configId === 'model') currentModel = value;
        else if (configId === 'variant') currentVariant = value;
        else if (configId === 'fast') fast = value === true;
        reply(message.id, { configOptions: configOptions() });
        break;
      }
      case 'session/prompt': {
        const prompt = message.params.prompt
          .map((block) => (block.type === 'text' ? block.text : ''))
          .join('');
        if (prompt.includes('HOLD')) break;
        if (prompt.includes('NATIVE_DENIAL')) {
          const read = await ask('fs/read_text_file', { sessionId, path: 'C:/private.txt' });
          const write = await ask('fs/write_text_file', {
            sessionId,
            path: 'C:/private.txt',
            content: 'no',
          });
          const permission = await ask('session/request_permission', {
            sessionId,
            toolCall: { toolCallId: 'native', title: 'Run shell' },
            options: [
              { optionId: 'deny', kind: 'reject_once', name: 'Reject' },
              { optionId: 'allow', kind: 'allow_once', name: 'Allow' },
            ],
          });
          text(
            read.error && write.error && permission.result?.outcome?.optionId === 'deny'
              ? 'DENIED'
              : 'UNSAFE',
          );
          reply(message.id, { stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } });
          break;
        }
        if (servers.length && !prompt.includes('TOOL_RESULT')) {
          const server = servers[0];
          const headers = {
            'content-type': 'application/json',
            authorization: server.headers[0].value,
          };
          const listed = await fetch(server.url, {
            method: 'POST',
            headers,
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
          }).then((response) => response.json());
          update({
            sessionUpdate: 'tool_call',
            toolCallId: 'acp-tool-1',
            title: 'caller tool',
            kind: 'read',
            status: 'pending',
          });
          await fetch(server.url, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 2,
              method: 'tools/call',
              params: { name: listed.result.tools[0].name, arguments: { path: 'marker.txt' } },
            }),
          });
          break;
        }
        if (prompt.includes('GO_HIGH_CONTINUE')) {
          text('TOOL_RESULT::CLI_SAFE_VALUE');
          reply(message.id, {
            stopReason: 'end_turn',
            usage: { inputTokens: 12953, outputTokens: 12, thoughtTokens: 41 },
          });
          break;
        }
        if (prompt.includes('GO_HIGH')) {
          text('NATIVE_TOOLS_UNAVAILABLE');
          reply(message.id, {
            stopReason: 'end_turn',
            // Text-only output counter plus a separate reasoning counter; no cache fields reported.
            usage: { inputTokens: 12776, outputTokens: 9, thoughtTokens: 307 },
          });
          break;
        }
        if (prompt.includes('OMIT_USAGE')) {
          text('NO_USAGE');
          reply(message.id, { stopReason: 'end_turn' });
          break;
        }
        if (prompt.includes('ZERO_USAGE')) {
          text('ZERO');
          reply(message.id, {
            stopReason: 'end_turn',
            usage: {
              totalTokens: 0,
              inputTokens: 0,
              outputTokens: 0,
              cachedReadTokens: 0,
              cachedWriteTokens: 0,
              thoughtTokens: 0,
            },
          });
          break;
        }
        if (prompt.includes('PARTIAL_USAGE')) {
          text('PARTIAL');
          reply(message.id, { stopReason: 'end_turn', usage: { cachedReadTokens: 3 } });
          break;
        }
        if (prompt.includes('NONASCII')) {
          text('héllo‑世界🌈');
          reply(message.id, { stopReason: 'end_turn', usage: { inputTokens: 4, outputTokens: 2 } });
          break;
        }
        const keyState = process.env.OPENCODE_API_KEY ? 'key' : 'nokey';
        const provider = currentModel.split('/')[0] ?? '';
        const effective = effectiveCredential(provider);
        // `FERRY_OC_EXPECT_KEY` lets a test assert the CLI resolved exactly the offered credential.
        const expected = process.env.FERRY_OC_EXPECT_KEY;
        const match = expected ? (effective.key === expected ? 'yes' : 'no') : 'none';
        const dataState = (process.env.XDG_DATA_HOME ?? '').includes('ferry-opencode')
          ? 'private'
          : 'native';
        // Isolation probe: the child must run with PWD pinned to its private cwd, project-local
        // config discovery disabled, and no inherited OPENCODE_CONFIG/CONFIG_DIR pointers.
        const pwdState =
          process.env.PWD === process.cwd()
            ? 'pwd-private'
            : `pwd-leaked:${process.env.PWD ?? 'none'}`;
        const projState =
          process.env.OPENCODE_DISABLE_PROJECT_CONFIG === '1' ? 'proj-off' : 'proj-on';
        const configEnvState =
          process.env.OPENCODE_CONFIG || process.env.OPENCODE_CONFIG_DIR
            ? 'config-env-on'
            : 'config-env-off';
        const enabled = (() => {
          try {
            return (
              JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? '{}').enabled_providers ?? []
            ).join(',');
          } catch {
            return '';
          }
        })();
        text(
          `CONFIG|${currentModel}|${currentVariant}|${fast ? 'fast' : 'standard'}|${keyState}|${dataState}|${enabled}|${
            prompt.includes('TOOL_RESULT') ? 'TOOL_RESULT' : ''
          }|${pwdState}|${projState}|${configEnvState}|src:${effective.source}|match:${match}`,
        );
        reply(message.id, { stopReason: 'end_turn', usage: { inputTokens: 12, outputTokens: 2 } });
        break;
      }
      case 'session/cancel':
        break;
      default:
        reply(message.id, {});
    }
  })().catch(() => process.exit(1));
}
