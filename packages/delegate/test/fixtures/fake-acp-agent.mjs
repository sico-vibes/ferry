/* eslint-disable @typescript-eslint/await-thenable */
import { Readable, Writable } from 'node:stream';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { agent, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';

const app = agent({ name: 'fake-acp-agent', version: '1.0.0' });
app.onRequest('initialize', () => ({
  protocolVersion: PROTOCOL_VERSION,
  agentCapabilities: {},
  ...(process.env.FAKE_ACP_AUTH === '1'
    ? {
        authMethods: [
          { id: 'fake-login', name: 'Fake login', description: 'Use fixture authentication' },
        ],
      }
    : {}),
}));
app.onRequest('authenticate', ({ params }) => {
  if (params.methodId !== 'fake-login') throw new Error('unexpected auth method');
  return {};
});
app.onRequest('session/new', ({ params }) => ({ sessionId: 'fake-acp-session', ...params }));
app.onRequest('session/resume', ({ params }) => ({ sessionId: params.sessionId }));
app.onRequest('session/prompt', async ({ params, client, signal }) => {
  if (process.env.FAKE_ACP_CRASH === '1') process.exit(17);
  if (process.env.FAKE_ACP_HOLD === '1') {
    if (process.env.FAKE_ACP_CHILD_PID_FILE) {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      await writeFile(process.env.FAKE_ACP_CHILD_PID_FILE, String(child.pid));
    }
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    return { stopReason: 'cancelled' };
  }
  const filePath =
    process.env.FAKE_ACP_ESCAPE === '1'
      ? resolve(process.cwd(), '..', 'escape.txt')
      : resolve(process.cwd(), `${params.sessionId}.txt`);
  await client.request('fs/write_text_file', {
    sessionId: params.sessionId,
    path: filePath,
    content: 'written by fake ACP',
  });
  await client.request('session/request_permission', {
    sessionId: params.sessionId,
    toolCall: {
      toolCallId: 'permission-1',
      title: 'Run test command',
      kind: 'execute',
      status: 'pending',
    },
    options: [
      { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
    ],
  });
  await client.notify('session/update', {
    sessionId: params.sessionId,
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Fake agent finished.' },
    },
  });
  return { stopReason: 'end_turn', usage: { inputTokens: 7, outputTokens: 4 } };
});
app.connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
