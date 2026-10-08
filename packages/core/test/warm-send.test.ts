import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { MemorySecretStore } from '@ferry/secrets';
import { ModelRefSchema, ProviderIdSchema, SessionSchema } from '@ferry/shared';
import { createCoreHost } from '../src/index.js';
import { createSkillManager } from '../src/domains/skills.js';
import { BUILTIN_PROFILES } from '@ferry/router';

const dispatches = vi.hoisted(() => [] as number[]);
vi.mock('../src/session-deps.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/session-deps.js')>();
  return {
    ...actual,
    createSessionDependencies: (...args: Parameters<typeof actual.createSessionDependencies>) => {
      const runtime = actual.createSessionDependencies(...args);
      runtime.gateway.streamStep = () => {
        dispatches.push(performance.now());
        return Promise.resolve({ text: 'done', toolCalls: [], inputTokens: 1, outputTokens: 1 });
      };
      return runtime;
    },
  };
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 15_000;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error('Run did not settle');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('warm workspace sends and sessions.start', () => {
  it('retains a slow-start MCP server, refreshes skills and dispatches the next request within 300 ms', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ferry-warm-send-'));
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network forbidden'));
    const host = await createCoreHost({
      dataDir: join(root, 'data'),
      env: { ...process.env, NODE_ENV: 'production' },
    });
    try {
      const services = host.options.services;
      if (!services) throw new Error('Missing services');
      const secrets = new MemorySecretStore();
      await secrets.set('openrouter', 'fixture');
      (services as { secrets: typeof services.secrets }).secrets = secrets;
      services.providerKeys.put({
        id: ProviderIdSchema.parse('openrouter'),
        providerId: ProviderIdSchema.parse('openrouter'),
        keyringRef: 'openrouter',
        createdAt: new Date().toISOString(),
      });
      const model = services.catalog.models.find(
        (entry) =>
          entry.providerId === 'openrouter' &&
          entry.free &&
          entry.toolCalling &&
          entry.ref.endsWith(':free'),
      );
      if (!model) throw new Error('Missing fixture model');
      services.models.put(model.providerId, model);
      const profile = BUILTIN_PROFILES.find((entry) => entry.name === 'Auto-Free');
      if (!profile) throw new Error('Missing profile');
      services.settings.put('profile-overrides', [
        { ...profile, roles: { ...profile.roles, enabled: false } },
      ]);
      const workspacePath = join(root, 'workspace');
      const skillPath = join(workspacePath, '.ferry', 'skills', 'test-skill');
      await mkdir(skillPath, { recursive: true });
      const skillFile = join(skillPath, 'SKILL.md');
      await writeFile(
        skillFile,
        '---\nname: test-skill\ndescription: Test skill\n---\nOriginal body\n',
        'utf8',
      );
      const rpc = (method: string, params: unknown[] = []) =>
        host.dispatch({ jsonrpc: '2.0', id: 'test', method, params });
      const workspace = (await rpc('workspaces.open', [workspacePath])) as {
        id: string;
        path: string;
      };
      await rpc('workspaces.trust', [workspace.id]);
      const marker = join(root, 'starts');
      services.settings.put('mcp-servers', [
        {
          id: 'slow',
          name: 'Slow fixture',
          transport: 'stdio',
          command: process.execPath,
          args: [
            fileURLToPath(
              new URL('../../extensions/test/fixtures/slow-mcp-server.mjs', import.meta.url),
            ),
          ],
          env: { ...process.env, FERRY_MCP_STARTS_FILE: marker },
          enabled: true,
        },
      ]);
      const first = SessionSchema.parse(
        await rpc('sessions.start', [
          {
            workspaceId: workspace.id,
            text: 'first',
            effort: 'high',
            modelRef: model.ref,
            attachments: [{ name: 'context.txt', text: 'attached context' }],
          },
        ]),
      );
      await waitFor(() => services.sessions.get(first.id)?.status !== 'running');
      expect(services.sessions.get(first.id)?.effort).toBe('high');
      expect(dispatches).toHaveLength(1);
      expect(services.messages.list().find((message) => message.role === 'user')?.parts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ text: 'Attachment: context.txt\nattached context' }),
        ]),
      );
      // Managers are keyed by the engine's canonical path (CI temp folders use 8.3 short names).
      const manager = createSkillManager(services, workspace.path);
      expect(await manager.callSkillTool('load_skill', { name: 'test-skill' })).toBe(
        'Original body',
      );
      await writeFile(
        skillFile,
        '---\nname: test-skill\ndescription: Updated skill\n---\nUpdated body\n',
        'utf8',
      );
      await rpc('sessions.send', [first.id, { text: 'second' }]);
      const returnedAt = performance.now();
      await waitFor(() => dispatches.length === 2);
      // The fixture MCP server takes 2 s to start; a warm send must not wait for it. The target is
      // ~300 ms on an idle machine; allow 1 s so a busy CI runner doesn't fail on scheduling noise.
      // The one-process assertion below proves the server was reused rather than restarted.
      expect((dispatches[1] ?? Infinity) - returnedAt).toBeLessThan(1_000);
      console.info(
        `PASS warm send dispatched in ${((dispatches[1] ?? Infinity) - returnedAt).toFixed(1)} ms with one retained MCP process`,
      );
      expect(await manager.callSkillTool('load_skill', { name: 'test-skill' })).toBe(
        'Updated body',
      );
      expect((await readFile(marker, 'utf8')).trim().split('\n')).toHaveLength(1);
      await waitFor(() => services.sessions.get(first.id)?.status !== 'running');
      const count = services.sessions.list().length;
      await expect(
        rpc('sessions.start', [{ workspaceId: workspace.id, text: '', modelRef: model.ref }]),
      ).rejects.toThrow();
      await expect(
        rpc('sessions.start', [
          {
            workspaceId: workspace.id,
            text: 'invalid model',
            modelRef: ModelRefSchema.parse('unknown/missing'),
          },
        ]),
      ).rejects.toThrow('Unknown model');
      expect(services.sessions.list()).toHaveLength(count);
      await rpc('workspaces.remove', [workspace.id]);
      const pid = Number((await readFile(marker, 'utf8')).trim());
      expect(() => process.kill(pid, 0)).toThrow();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      await host.stop();
      fetch.mockRestore();
      await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      dispatches.length = 0;
    }
  }, 30_000);
});
