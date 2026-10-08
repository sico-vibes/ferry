import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { GeneratedStep, StepGeneratorInput } from '@ferry/agent';
import { createRpcFerryClient, type RpcFerryClient } from '@ferry/client';
import { MemorySecretStore } from '@ferry/secrets';
import {
  MessageSchema,
  PartIdSchema,
  ProviderIdSchema,
  newId,
  type SessionId,
  type Workspace,
} from '@ferry/shared';
import { BUILTIN_PROFILES } from '@ferry/router';
import {
  createCoreHost,
  createMemoryTransportPair,
  type CoreHost,
  type FerryServices,
} from '../src/index.js';

const provider = vi.hoisted(() => ({
  turns: [] as GeneratedStep[],
  prompts: [] as string[],
}));
vi.mock('../src/session-deps.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/session-deps.js')>();
  return {
    ...actual,
    createSessionDependencies: (...args: Parameters<typeof actual.createSessionDependencies>) => {
      const runtime = actual.createSessionDependencies(...args);
      runtime.gateway.streamStep = (request: StepGeneratorInput) => {
        provider.prompts.push(request.system);
        return Promise.resolve(provider.turns.shift() ?? { text: 'done', toolCalls: [] });
      };
      return runtime;
    },
  };
});

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

describe('Projects and Recents through core RPC', () => {
  let root: string;
  let host: CoreHost;
  let rpc: RpcFerryClient;
  let services: FerryServices;
  let workspace: Workspace;
  let network: MockInstance<typeof globalThis.fetch>;

  beforeEach(async () => {
    provider.turns.length = 0;
    provider.prompts.length = 0;
    network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network forbidden'));
    const temporaryRoot = fileURLToPath(new URL('../../../.dev/test-tmp/', import.meta.url));
    await mkdir(temporaryRoot, { recursive: true });
    root = await mkdtemp(join(temporaryRoot, 'projects-recents-'));
    const [coreTransport, clientTransport] = createMemoryTransportPair();
    const secrets = new MemorySecretStore();
    await secrets.set('openrouter', 'fixture');
    host = await createCoreHost({
      dataDir: join(root, 'data'),
      transport: coreTransport,
      env: { ...process.env, NODE_ENV: 'production' },
    });
    if (!host.options.services) throw new Error('Missing services');
    services = host.options.services;
    (services as { secrets: FerryServices['secrets'] }).secrets = secrets;
    const providerId = ProviderIdSchema.parse('openrouter');
    services.providerKeys.put({
      id: providerId,
      providerId,
      keyringRef: 'openrouter',
      createdAt: new Date().toISOString(),
    });
    const model = services.catalog.models.find(
      (entry) =>
        entry.providerId === providerId &&
        entry.free &&
        entry.toolCalling &&
        entry.ref.endsWith(':free'),
    );
    if (!model) throw new Error('Missing fixture model');
    services.models.put(providerId, model);
    const profile = BUILTIN_PROFILES.find((entry) => entry.name === 'Auto-Free');
    if (!profile) throw new Error('Missing profile');
    services.settings.put('profile-overrides', [
      { ...profile, roles: { ...profile.roles, enabled: false } },
    ]);
    rpc = createRpcFerryClient(clientTransport);
    await rpc.hello;
    await rpc.settings.update({ permissionMode: 'full_auto' });
    const project = join(root, 'project');
    await mkdir(project);
    workspace = await rpc.workspaces.open(project);
    await rpc.workspaces.trust(workspace.id);
  });

  afterEach(async () => {
    try {
      rpc.close();
      await host.stop();
      expect(network).not.toHaveBeenCalled();
    } finally {
      network.mockRestore();
      await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  const settle = async (id: SessionId) => {
    await vi.waitFor(
      async () => {
        const session = (await rpc.sessions.get(id)).session;
        expect(session.status).toBe('idle');
        expect(session.inFlight).toBe(false);
      },
      { timeout: 15_000, interval: 10 },
    );
  };
  const scratch = (id: SessionId) => join(services.dataDir, 'scratch', id);
  const writeTurn = (path: string, content: string): GeneratedStep => ({
    toolCalls: [{ id: newId('call'), name: 'write_file', input: { path, content } }],
  });

  it('creates scratch lazily, writes only inside it, and omits the git block from Recent prompts', async () => {
    const recent = await rpc.sessions.create({});
    expect(recent).toMatchObject({ workspaceId: null, archived: false });
    expect(await stat(scratch(recent.id)).catch(() => null)).toBeNull();
    const outside = join(workspace.path, 'escape.txt');
    provider.turns.push(writeTurn('note.txt', 'private'), writeTurn(outside, 'escape'), {
      text: 'finished',
    });
    await rpc.sessions.send(recent.id, { text: 'write a private note' });
    await settle(recent.id);
    expect(await readFile(join(scratch(recent.id), 'note.txt'), 'utf8')).toBe('private');
    expect(await readdir(workspace.path)).toEqual([]);
    expect(await stat(outside).catch(() => null)).toBeNull();
    const tools = (await rpc.sessions.get(recent.id)).messages
      .flatMap((message) => message.parts)
      .filter((part) => part.type === 'tool_call');
    expect(tools).toEqual(
      expect.arrayContaining([expect.objectContaining({ tool: 'write_file', status: 'failed' })]),
    );
    expect(provider.prompts.length).toBeGreaterThan(0);
    for (const prompt of provider.prompts) {
      expect(prompt).toContain('private scratch folder and no user project');
      expect(prompt).not.toMatch(/Git branch:|Git status:|Project instructions \(/);
    }
    expect(await rpc.workspaces.list()).toHaveLength(1);
    expect(await rpc.checkpoints.list(recent.id)).not.toHaveLength(0);
  });

  it('starts a Recent even when a project is open', async () => {
    provider.turns.push({ text: 'Recent reply' });
    const recent = await rpc.sessions.start({ text: 'hello' });
    await settle(recent.id);
    expect(recent.workspaceId).toBeNull();
    expect(await stat(scratch(recent.id))).toBeTruthy();
    const reply = (await rpc.sessions.get(recent.id)).messages.find(
      (message) => message.role === 'assistant',
    );
    expect(reply?.parts).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'text', text: 'Recent reply' })]),
    );
  });

  it('moves between project and Recents, retaining old scratch files and starting a fresh scratch folder', async () => {
    const recent = await rpc.sessions.create({});
    provider.turns.push(writeTurn('original.txt', 'retained'), { text: 'done' });
    await rpc.sessions.send(recent.id, { text: 'first' });
    await settle(recent.id);
    expect((await rpc.sessions.move(recent.id, workspace.id)).workspaceId).toBe(workspace.id);
    provider.turns.push(writeTurn('project.txt', 'project'), { text: 'done' });
    await rpc.sessions.send(recent.id, { text: 'second' });
    await settle(recent.id);
    expect(await readFile(join(workspace.path, 'project.txt'), 'utf8')).toBe('project');
    expect(await readFile(join(scratch(recent.id), 'original.txt'), 'utf8')).toBe('retained');
    await rpc.sessions.move(recent.id, null);
    provider.turns.push(writeTurn('fresh.txt', 'new'), { text: 'done' });
    await rpc.sessions.send(recent.id, { text: 'third' });
    await settle(recent.id);
    expect(await stat(join(scratch(recent.id), 'original.txt')).catch(() => null)).toBeNull();
    expect(await readFile(join(scratch(recent.id), 'fresh.txt'), 'utf8')).toBe('new');
    const retainedRoot = join(services.dataDir, 'scratch-retained', recent.id);
    const retained = await readdir(retainedRoot);
    expect(retained).toHaveLength(1);
    const retainedFolder = retained[0];
    if (!retainedFolder) throw new Error('Missing retained scratch folder');
    expect(await readFile(join(retainedRoot, retainedFolder, 'original.txt'), 'utf8')).toBe(
      'retained',
    );
    await rpc.sessions.remove(recent.id);
    expect(await stat(scratch(recent.id)).catch(() => null)).toBeNull();
    expect(await stat(retainedRoot).catch(() => null)).toBeNull();
    expect(await readFile(join(workspace.path, 'project.txt'), 'utf8')).toBe('project');
    await expect(rpc.sessions.get(recent.id)).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('refuses moving a running chat with a typed conflict and preserves its workspace', async () => {
    const running = await rpc.sessions.create({ workspaceId: workspace.id });
    for (const state of [
      { status: 'running' as const, inFlight: false },
      { status: 'error' as const, inFlight: true },
    ]) {
      services.sessions.put({ ...running, ...state });
      await expect(rpc.sessions.move(running.id, null)).rejects.toMatchObject({
        code: -32010,
        kind: 'conflict',
        details: { sessionId: running.id, status: state.status },
      });
      expect((await rpc.sessions.get(running.id)).session.workspaceId).toBe(workspace.id);
    }
    services.sessions.put(running);
    await rpc.settings.update({ permissionMode: 'ask' });
    provider.turns.push(writeTurn('approval.txt', 'pending'));
    const recent = await rpc.sessions.start({ text: 'write' });
    await vi.waitFor(
      async () => {
        expect((await rpc.sessions.get(recent.id)).session.status).toBe('awaiting_approval');
      },
      { timeout: 15_000 },
    );
    await expect(rpc.sessions.move(recent.id, workspace.id)).rejects.toMatchObject({
      code: -32010,
      kind: 'conflict',
      details: { sessionId: recent.id, status: 'awaiting_approval' },
    });
    expect((await rpc.sessions.get(recent.id)).session.workspaceId).toBeNull();
    await rpc.sessions.remove(recent.id);
    expect(await stat(scratch(recent.id)).catch(() => null)).toBeNull();
  });

  it('filters archived chats, supports includeArchived, and archives only the selected project', async () => {
    const a = await rpc.sessions.create({ workspaceId: workspace.id });
    const b = await rpc.sessions.create({ workspaceId: workspace.id });
    const recent = await rpc.sessions.create({});
    const events: string[] = [];
    const off = rpc.on('session.updated', (session) => {
      if (session.archived) events.push(session.id);
    });
    await rpc.sessions.archive(a.id, true);
    expect((await rpc.sessions.list()).map((s) => s.id)).not.toContain(a.id);
    expect((await rpc.sessions.list({ includeArchived: true })).map((s) => s.id)).toContain(a.id);
    expect((await rpc.sessions.search()).map((s) => s.id)).not.toContain(a.id);
    expect((await rpc.sessions.search({ includeArchived: true })).map((s) => s.id)).toContain(a.id);
    await rpc.sessions.archive(a.id, false);
    expect((await rpc.workspaces.list())[0]?.chatCount).toBe(2);
    await rpc.workspaces.archiveChats(workspace.id);
    expect(await rpc.sessions.list({ workspaceId: workspace.id })).toEqual([]);
    expect(
      await rpc.sessions.list({ workspaceId: workspace.id, includeArchived: true }),
    ).toHaveLength(2);
    expect((await rpc.workspaces.list())[0]).toMatchObject({
      chatCount: 0,
      lastActivityAt: [
        (await rpc.sessions.get(a.id)).session.updatedAt,
        (await rpc.sessions.get(b.id)).session.updatedAt,
      ]
        .sort()
        .at(-1),
    });
    expect(await rpc.sessions.list({ workspaceId: null })).toEqual([
      expect.objectContaining({ id: recent.id, archived: false }),
    ]);
    expect(events).toContain(a.id);
    expect(events).toContain(b.id);
    off();
  });

  it('renames and pins projects while preserving both settings patch forms, then archives and detaches removed project chats', async () => {
    const chat = await rpc.sessions.create({ workspaceId: workspace.id });
    await rpc.workspaces.update(workspace.id, {
      name: 'Renamed',
      pinned: true,
      settings: { gateCommands: ['test'] },
    });
    await rpc.workspaces.update(workspace.id, { permissionMode: 'auto_edit' });
    expect((await rpc.workspaces.list())[0]).toMatchObject({
      name: 'Renamed',
      pinned: true,
      chatCount: 1,
      settings: { gateCommands: ['test'], permissionMode: 'auto_edit' },
    });
    await rpc.workspaces.remove(workspace.id);
    expect(await rpc.workspaces.list()).toEqual([]);
    expect(await rpc.sessions.list()).toEqual([]);
    expect(await rpc.sessions.list({ includeArchived: true })).toEqual([
      expect.objectContaining({ id: chat.id, workspaceId: null, archived: true }),
    ]);
    await rpc.sessions.archive(chat.id, false);
    provider.turns.push(writeTurn('detached.txt', 'usable'), { text: 'done' });
    await rpc.sessions.send(chat.id, { text: 'continue detached' });
    await settle(chat.id);
    expect(await readFile(join(scratch(chat.id), 'detached.txt'), 'utf8')).toBe('usable');
  });

  it('searches message text case-insensitively with a snippet and updates its cached index', async () => {
    const chat = await rpc.sessions.create({ workspaceId: workspace.id, title: 'Ordinary title' });
    const other = await rpc.sessions.create({});
    const message = (sessionId: SessionId, text: string) =>
      MessageSchema.parse({
        id: newId('message'),
        sessionId,
        role: 'assistant',
        createdAt: new Date().toISOString(),
        modelRef: null,
        parts: [{ id: newId('part'), type: 'text', text }],
      });
    for (let i = 0; i < 6_000; i++)
      services.messages.put(
        message(i % 2 ? chat.id : other.id, `Unrelated transcript message ${String(i)}`),
      );
    const match = message(
      chat.id,
      `${'prefix '.repeat(20)}The NEEDLE exists only in message text. ${'suffix '.repeat(20)}`,
    );
    services.messages.put(match);
    const coldStart = performance.now();
    const results = await rpc.sessions.search({ query: 'needle', workspaceId: workspace.id });
    const cold = performance.now() - coldStart;
    const warmStart = performance.now();
    await rpc.sessions.search({ query: 'needle' });
    const warm = performance.now() - warmStart;
    console.info(
      `PASS sessions.search: 6001 messages, first ${cold.toFixed(2)} ms, cached ${warm.toFixed(2)} ms`,
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe(chat.id);
    expect(results[0]?.match).toContain('NEEDLE');
    expect(results[0]?.match.length).toBeLessThanOrEqual(126);
    expect(await rpc.sessions.search({ query: 'needle', workspaceId: null })).toEqual([]);
    await rpc.sessions.archive(chat.id, true);
    expect(await rpc.sessions.search({ query: 'needle' })).toEqual([]);
    expect(await rpc.sessions.search({ query: 'needle', includeArchived: true })).toHaveLength(1);
    services.messages.put({
      ...match,
      parts: [{ id: PartIdSchema.parse(newId('part')), type: 'text', text: 'replacement text' }],
    });
    expect(await rpc.sessions.search({ query: 'needle', includeArchived: true })).toEqual([]);
    expect(await rpc.sessions.search({ query: 'replacement', includeArchived: true })).toHaveLength(
      1,
    );
    services.messages.delete(match.id);
    expect(await rpc.sessions.search({ query: 'replacement', includeArchived: true })).toEqual([]);
  });

  it('searches 20k files with gitignore rules and fuzzy ranking in under 150 ms after the first call', async () => {
    await writeFile(join(workspace.path, '.gitignore'), 'ignored/\n*.secret\n', 'utf8');
    await mkdir(join(workspace.path, 'ignored'));
    await mkdir(join(workspace.path, '.git'));
    await writeFile(join(workspace.path, 'ignored', 'needle.ts'), '');
    await writeFile(join(workspace.path, '.git', 'needle.ts'), '');
    await writeFile(join(workspace.path, 'needle.secret'), '');
    await writeFile(join(workspace.path, 'needle.ts'), '');
    await writeFile(join(workspace.path, 'needle-more.ts'), '');
    await writeFile(join(workspace.path, 'n-e-e-d-l-e.ts'), '');
    for (let batch = 0; batch < 100; batch++) {
      await Promise.all(
        Array.from({ length: 200 }, (_, index) =>
          writeFile(join(workspace.path, `file-${String(batch * 200 + index)}.ts`), ''),
        ),
      );
    }
    const coldStart = performance.now();
    await rpc.workspaces.searchFiles({ workspaceId: workspace.id, query: 'needle', limit: 200 });
    const cold = performance.now() - coldStart;
    const warmStart = performance.now();
    const results = await rpc.workspaces.searchFiles({
      workspaceId: workspace.id,
      query: 'needle',
      limit: 200,
    });
    const warm = performance.now() - warmStart;
    console.info(
      `PASS workspaces.searchFiles: 20007 files, first ${cold.toFixed(2)} ms, cached ${warm.toFixed(2)} ms`,
    );
    expect(warm).toBeLessThan(150);
    expect(results.map((entry) => entry.name)).toEqual([
      'needle.ts',
      'needle-more.ts',
      'n-e-e-d-l-e.ts',
    ]);
    expect(results.map((entry) => entry.path)).toEqual([
      'needle.ts',
      'needle-more.ts',
      'n-e-e-d-l-e.ts',
    ]);
    expect(
      await rpc.workspaces.searchFiles({ workspaceId: workspace.id, query: 'needle', limit: 1 }),
    ).toEqual([results[0]]);
  });
});
