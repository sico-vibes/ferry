import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createRpcFerryClient } from '@ferry/client';
import { MemorySecretStore } from '@ferry/secrets';
import { ModelRefSchema, ProviderIdSchema, type AgentEvent } from '@ferry/shared';
import { CoreHost, createMemoryTransportPair } from '../src/index.js';
import { createServices } from '../src/services.js';
import { domainRegistrars } from '../src/domains/index.js';
import { getModelDiscovery } from '../src/domains/model-discovery.js';

const modelId = 'qwen/qwen3.8-27b:free';
const modelRef = ModelRefSchema.parse(`openrouter/${modelId}`);
const reasoning = 'The user wants a short answer with a code sample. ';
const reply = 'Here is a tiny example:\n\n```ts\nexport const add = ...\n```\n';

async function startHarness(fail = false) {
  const root = await mkdtemp(join(tmpdir(), 'ferry-final-reply-'));
  let calls = 0;
  const network = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === 'http://127.0.0.1:1/v1/models')
      return Promise.resolve(
        Response.json({
          data: [{ id: modelId, supported_parameters: ['tools', 'reasoning'] }],
        }),
      );
    if (url !== 'http://127.0.0.1:1/v1/chat/completions')
      throw new Error(`Unexpected fetch: ${url}`);
    calls++;
    if (fail)
      return Promise.resolve(
        Response.json({ error: { message: 'fixture provider failure' } }, { status: 400 }),
      );
    const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
      id: 'chatcmpl_final_reply',
      object: 'chat.completion.chunk',
      created: 1,
      model: modelId,
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
    const chunks = [
      chunk({ role: 'assistant' }),
      chunk({ reasoning }),
      chunk({ content: reply }),
      {
        ...chunk({}, 'stop'),
        usage: {
          prompt_tokens: 1108,
          completion_tokens: 93,
          completion_tokens_details: { reasoning_tokens: 58 },
        },
      },
    ];
    return Promise.resolve(
      new Response(
        chunks.map((part) => `data: ${JSON.stringify(part)}\n\n`).join('') + 'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      ),
    );
  });
  const services = await createServices({
    dataDir: root,
    env: { NODE_ENV: 'test', FERRY_PROVIDER_BASE_URL_OPENROUTER: 'http://127.0.0.1:1/v1' },
    secrets: new MemorySecretStore(),
  });
  const [transport, clientTransport] = createMemoryTransportPair();
  const host = new CoreHost({ dataDir: root, transport, services });
  for (const register of domainRegistrars) register(host, services);
  await host.start();
  const rpc = createRpcFerryClient(clientTransport);
  const events: AgentEvent[] = [];
  rpc.on('agent.event', ({ event }) => events.push(event));
  const close = async () => {
    rpc.close();
    try {
      await host.stop();
    } finally {
      network.mockRestore();
      await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  };
  try {
    await rpc.hello;
    const providerId = ProviderIdSchema.parse('openrouter');
    await rpc.providers.setKey(providerId, 'final-reply-fixture');
    await rpc.providers.setEnabled(providerId, true);
    await getModelDiscovery(host, services).refresh(providerId);
    expect(await rpc.models.list(providerId)).toContainEqual(
      expect.objectContaining({ ref: modelRef, verified: true }),
    );
    return { rpc, events, calls: () => calls, close };
  } catch (error) {
    await close();
    throw error;
  }
}

describe('final replies through core sessions', () => {
  it(
    'finishes a pinned Recent reply with reasoning and final usage after one call',
    { timeout: 30_000 },
    async () => {
      const h = await startHarness();
      try {
        const session = await h.rpc.sessions.start({ text: 'Show a tiny add example.', modelRef });
        await vi.waitFor(
          async () => {
            expect((await h.rpc.sessions.get(session.id)).session.inFlight).toBe(false);
          },
          { timeout: 15_000, interval: 10 },
        );
        const detail = await h.rpc.sessions.get(session.id);
        expect(detail.session, JSON.stringify(detail)).toMatchObject({
          workspaceId: null,
          status: 'idle',
          pinnedModelRef: modelRef,
        });
        const assistants = detail.messages.filter((message) => message.role === 'assistant');
        expect(assistants).toHaveLength(1);
        expect(assistants[0]).toMatchObject({ modelRef });
        expect(assistants[0]?.parts).toContainEqual(
          expect.objectContaining({ type: 'text', text: reply }),
        );
        expect(
          detail.messages
            .flatMap((message) => message.parts)
            .filter((part) => part.type === 'error'),
        ).toEqual([]);
        expect(h.calls()).toBe(1);
        expect(h.events).toContainEqual(
          expect.objectContaining({
            type: 'usage',
            inputTokens: 1108,
            outputTokens: 93,
            reasoningTokens: 58,
          }),
        );
        expect(h.events).toContainEqual(
          expect.objectContaining({ type: 'thinking', content: reasoning }),
        );
      } finally {
        await h.close();
      }
    },
  );

  it('records a genuine provider failure exactly once', { timeout: 30_000 }, async () => {
    const h = await startHarness(true);
    try {
      const session = await h.rpc.sessions.start({ text: 'Fail this reply.', modelRef });
      await vi.waitFor(
        async () => {
          expect((await h.rpc.sessions.get(session.id)).session.inFlight).toBe(false);
        },
        { timeout: 15_000, interval: 10 },
      );
      const detail = await h.rpc.sessions.get(session.id);
      expect(detail.session.status).toBe('error');
      const errors = detail.messages
        .flatMap((message) => message.parts)
        .filter((part) => part.type === 'error');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({
        kind: 'provider',
        details: { attempts: [expect.objectContaining({ message: 'fixture provider failure' })] },
      });
      expect(detail.messages.filter((message) => message.role === 'assistant')).toHaveLength(1);
      expect(h.calls()).toBe(1);
    } finally {
      await h.close();
    }
  });
});
