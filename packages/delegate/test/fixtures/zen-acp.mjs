import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin });
let servers = [];
const send = (value) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`);
const reply = (id, result) => send({ id, result });
const update = (text) =>
  send({
    method: 'session/update',
    params: {
      sessionId: 'fixture-session',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    },
  });
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
          agentCapabilities: {},
          authMethods: [{ id: 'login', name: 'Optional login' }],
        });
        break;
      case 'session/new':
        servers = message.params.mcpServers;
        reply(message.id, {
          sessionId: 'fixture-session',
          configOptions: [
            {
              id: 'model',
              name: 'Model',
              category: 'model',
              type: 'select',
              currentValue: 'opencode/big-pickle',
              options: [{ value: 'opencode/big-pickle', name: 'Big Pickle' }],
            },
          ],
        });
        break;
      case 'session/set_config_option':
        reply(message.id, { configOptions: [] });
        break;
      case 'session/prompt': {
        const prompt = message.params.prompt[0].text;
        if (prompt.includes('CHECK_NATIVE_DENIAL')) {
          const read = await ask('fs/read_text_file', {
            sessionId: 'fixture-session',
            path: 'C:/private.txt',
          });
          const write = await ask('fs/write_text_file', {
            sessionId: 'fixture-session',
            path: 'C:/private.txt',
            content: 'no',
          });
          const permission = await ask('session/request_permission', {
            sessionId: 'fixture-session',
            toolCall: { toolCallId: 'native', title: 'Run shell' },
            options: [
              { optionId: 'deny', kind: 'reject_once', name: 'Reject' },
              { optionId: 'allow', kind: 'allow_once', name: 'Allow' },
            ],
          });
          update(
            read.error && write.error && permission.result?.outcome?.optionId === 'deny'
              ? 'DENIED'
              : 'UNSAFE',
          );
        } else if (prompt.includes('WAIT_FOR_CANCEL')) {
          break;
        } else if (servers.length && !prompt.includes('CLI_TOOL_RESULT')) {
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
        } else {
          update(prompt.includes('CLI_TOOL_RESULT') ? 'CLI_TOOL_RESULT' : 'Ready.');
        }
        reply(message.id, {
          stopReason: 'end_turn',
          usage: { inputTokens: 12, outputTokens: 2, totalTokens: 14 },
        });
        break;
      }
      case 'session/cancel':
        break;
      default:
        reply(message.id, {});
    }
  })().catch(() => process.exit(1));
}
