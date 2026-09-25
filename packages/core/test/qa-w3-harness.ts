import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRpcFerryClient, type RpcFerryClient } from '@ferry/client';
import { MemorySecretStore } from '@ferry/secrets';
import { FakeOpenAIServer, type FakeResponse } from '@ferry/testkit';
import { ProviderIdSchema } from '@ferry/shared';
import type { Session, SessionId, Workspace, WorkspaceId } from '@ferry/shared';
import { createCoreHost, createMemoryTransportPair, type CoreHost } from '../src/index.js';
import type { FerryServices } from '../src/index.js';

export interface CoreHarness {
  root: string;
  dataDir: string;
  workspacePath: string;
  workspace: Workspace;
  workspaceId: WorkspaceId;
  host: CoreHost;
  rpc: RpcFerryClient;
  services: FerryServices;
  server: FakeOpenAIServer;
  close(): Promise<void>;
}

export interface HarnessOptions {
  turns?: FakeResponse[];
  env?: NodeJS.ProcessEnv;
  provider?: string;
  workspacePath?: string;
}

/** Every core QA harness enables one fake provider through a loopback server. */
export async function startHarness(options: HarnessOptions = {}): Promise<CoreHarness> {
  const provider = options.provider ?? 'openrouter';
  const server = new FakeOpenAIServer({ responses: options.turns ?? [textTurn('Hello.')] });
  await server.start();
  const root = await mkdtemp(join(tmpdir(), 'ferry-qa-w3-'));
  const dataDir = join(root, 'data');
  const workspacePath = options.workspacePath ?? join(root, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const baseName = `FERRY_PROVIDER_BASE_URL_${provider.toUpperCase()}`;
  const [coreTransport, clientTransport] = createMemoryTransportPair();
  const host = await createCoreHost({
    dataDir,
    transport: coreTransport,
    env: {
      ...process.env,
      [baseName]: `${server.baseUrl}/v1`,
      ...options.env,
    },
  });
  const services = host.options.services;
  if (!services) {
    await host.stop();
    await server.stop();
    throw new Error('Core services were not created');
  }
  // Real provider bindings route only through a stored key reference. Seed the
  // fixture directly into memory so tests never access the native keyring.
  const providerId = ProviderIdSchema.parse(provider);
  const secrets = new MemorySecretStore();
  await secrets.set(providerId, 'qa-w3-fixture-key');
  (services as { secrets: FerryServices['secrets'] }).secrets = secrets;
  services.providerKeys.put({
    id: providerId,
    providerId,
    keyringRef: providerId,
    createdAt: new Date().toISOString(),
  });
  const rpc = createRpcFerryClient(clientTransport, { timeoutMs: 15_000 });
  await rpc.hello;
  const workspace = await rpc.workspaces.open(workspacePath);
  return {
    root,
    dataDir,
    workspacePath,
    workspace,
    workspaceId: workspace.id,
    host,
    rpc,
    services,
    server,
    async close() {
      rpc.close();
      await host.stop();
      await server.stop();
      await rm(root, { recursive: true, force: true, maxRetries: 8 });
    },
  };
}

export function textTurn(text: string, options: { delayMs?: number } = {}): FakeResponse {
  const chunk = (delta: Record<string, unknown>, finish: string | null = null): unknown => ({
    id: 'chatcmpl_qa',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'fake',
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  const pieces = splitText(text);
  const chunks: unknown[] = [chunk({ role: 'assistant' })];
  for (const piece of pieces) chunks.push(chunk({ content: piece }));
  chunks.push(chunk({}, 'stop'));
  return options.delayMs === undefined ? { chunks } : { chunks, delayMs: options.delayMs };
}

export function toolTurn(name: string, args: Record<string, unknown>): FakeResponse {
  const chunk = (delta: Record<string, unknown>, finish: string | null = null): unknown => ({
    id: 'chatcmpl_qa',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'fake',
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  return {
    chunks: [
      chunk({ role: 'assistant' }),
      chunk({
        tool_calls: [
          { index: 0, id: 'call_qa_1', type: 'function', function: { name, arguments: '' } },
        ],
      }),
      chunk({
        tool_calls: [{ index: 0, function: { name, arguments: JSON.stringify(args) } }],
      }),
      chunk({}, 'tool_calls'),
    ],
  };
}

export function errorTurn(status = 429, message = 'rate limited'): FakeResponse {
  return { status, body: { error: { message, type: 'rate_limit_error' } } };
}

function splitText(text: string): string[] {
  if (text.length <= 1) return [text];
  const words = text.split(/(\s+)/).filter(Boolean);
  return words.length > 1 ? words : Array.from(text);
}

export const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
  intervalMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await delay(intervalMs);
  }
}

export async function sessionStatus(
  rpc: RpcFerryClient,
  sessionId: SessionId,
): Promise<Session['status']> {
  return (await rpc.sessions.get(sessionId)).session.status;
}

/**
 * Cancels a run and waits for the loop to settle before checking its durable
 * idle status. The cancellation RPC now resolves only after loop cleanup.
 */
export async function cancelAndSettle(h: CoreHarness, sessionId: SessionId): Promise<void> {
  await h.rpc.sessions.cancel(sessionId);
  await waitFor(async () => (await h.rpc.sessions.get(sessionId)).session.status === 'idle');
  await delay(150);
}
