import { afterEach, describe, expect, it } from 'vitest';
import {
  CapacitySummarySchema,
  CheckpointSchema,
  McpServerSchema,
  ModelCandidateSchema,
  ModelInfoSchema,
  OptimizerStatsSchema,
  ProfileSchema,
  ProviderSchema,
  SessionDetailSchema,
  SessionSchema,
  SettingsSchema,
  SkillSchema,
  SystemInfoSchema,
  UsageHistoryPointSchema,
  WorkspaceSchema,
} from '@ferry/shared';
import type { FerryClient } from '../ferry-client.js';

export function runFerryClientContract(
  name: string,
  make: () => Promise<{
    client: FerryClient;
    advance?: (ms: number) => Promise<void>;
    cleanup?: () => Promise<void> | void;
  }>,
  options: { domains?: readonly string[] } = {},
) {
  const waitForSettled = async (
    client: FerryClient,
    sessionId: import('@ferry/shared').SessionId,
  ) => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const status = (await client.sessions.get(sessionId)).session.status;
      if (status === 'idle' || status === 'error') return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Session ${sessionId} did not settle before contract cleanup`);
  };
  const selected = options.domains ? new Set(options.domains) : undefined;
  const includes = (domain: string) => selected === undefined || selected.has(domain);
  const skipped = selected
    ? [
        'approvals',
        'delegation',
        'mcp',
        'models',
        'optimizer',
        'profiles',
        'providers',
        'quota',
        'sessions',
        'skills',
      ].filter((domain) => !selected.has(domain))
    : [];
  describe(`${name} FerryClient contract${skipped.length ? ` (mock-only domains skipped: ${skipped.join(', ')})` : ''}`, () => {
    let cleanup: (() => Promise<void> | void) | undefined;
    afterEach(async () => {
      await cleanup?.();
      cleanup = undefined;
    }, 30_000);
    it('returns schema-valid data from every domain list/read', async () => {
      const made = await make();
      cleanup = made.cleanup;
      const { client } = made;
      if (includes('workspaces'))
        for (const x of await client.workspaces.list())
          expect(() => WorkspaceSchema.parse(x)).not.toThrow();
      if (includes('sessions'))
        for (const x of await client.sessions.list())
          expect(() => SessionSchema.parse(x)).not.toThrow();
      if (includes('sessions'))
        for (const x of await client.sessions.search({ query: 'contract' }))
          expect(() => SessionSchema.parse(x)).not.toThrow();
      if (includes('providers'))
        for (const x of await client.providers.list())
          expect(() => ProviderSchema.parse(x)).not.toThrow();
      if (includes('models'))
        for (const x of await client.models.list())
          expect(() => ModelInfoSchema.parse(x)).not.toThrow();
      if (includes('profiles'))
        for (const x of await client.profiles.list())
          expect(() => ProfileSchema.parse(x)).not.toThrow();
      if (includes('skills'))
        for (const x of await client.skills.list())
          expect(() => SkillSchema.parse(x)).not.toThrow();
      if (includes('mcp'))
        for (const x of await client.mcp.list())
          expect(() => McpServerSchema.parse(x)).not.toThrow();
      if (includes('delegation'))
        for (const x of await client.delegation.lanes()) expect(x.name).toBeTruthy();
      if (includes('settings')) SettingsSchema.parse(await client.settings.get());
      if (includes('quota')) {
        CapacitySummarySchema.parse(await client.quota.capacity());
        expect(
          (await client.quota.history(2)).every(
            (x) => UsageHistoryPointSchema.safeParse(x).success,
          ),
        ).toBe(true);
        expect((await client.quota.handoffs(30)).length).toBeGreaterThan(0);
      }
      if (includes('optimizer')) OptimizerStatsSchema.parse(await client.optimizer.stats());
      if (includes('system')) SystemInfoSchema.parse(await client.system.info());
      if (includes('sessions')) {
        for (const s of await client.sessions.list())
          SessionDetailSchema.parse(await client.sessions.get(s.id));
        for (const s of await client.sessions.list())
          for (const c of await client.checkpoints.list(s.id))
            expect(() => CheckpointSchema.parse(c)).not.toThrow();
        const first = (await client.sessions.list())[0];
        if (first && includes('models'))
          for (const candidate of await client.models.candidates(first.id))
            expect(() => ModelCandidateSchema.parse(candidate)).not.toThrow();
      }
    });
    it.skipIf(!includes('sessions'))('supports session CRUD round trips', async () => {
      const made = await make();
      cleanup = made.cleanup;
      const { client } = made;
      const workspace = (await client.workspaces.list())[0];
      if (!workspace) throw new Error('Contract workspace fixture missing');
      let session = await client.sessions.create({
        workspaceId: workspace.id,
        title: 'Contract session',
      });
      expect((await client.sessions.list()).some((x) => x.id === session.id)).toBe(true);
      session = await client.sessions.rename(session.id, 'Renamed');
      expect(session.title).toBe('Renamed');
      expect((await client.sessions.setStarred(session.id, true)).starred).toBe(true);
      expect((await client.sessions.setPinned(session.id, true)).pinned).toBe(true);
      await client.sessions.remove(session.id);
      expect((await client.sessions.list()).some((x) => x.id === session.id)).toBe(false);
    });
    it.skipIf(!includes('sessions') && !includes('settings'))(
      'emits assistant messages, allows unsubscribing, and accepts settings changes',
      async () => {
        const made = await make();
        cleanup = made.cleanup;
        const { client, advance } = made;
        if (includes('sessions')) {
          const workspace = (await client.workspaces.list())[0];
          if (!workspace) throw new Error('Contract workspace fixture missing');
          const s = await client.sessions.create({ workspaceId: workspace.id });
          let heard = 0;
          const off = client.on('session.message', () => heard++);
          await client.sessions.send(s.id, { text: 'hello' });
          if (advance) {
            await advance(600);
            await advance(150);
            await advance(150);
            await advance(150);
          } else await waitForSettled(client, s.id);
          expect(heard).toBeGreaterThanOrEqual(2);
          off();
          const count = heard;
          await client.sessions.send(s.id, { text: 'again' });
          if (advance) {
            await advance(600);
            await advance(150);
            await advance(150);
            await advance(150);
          } else await waitForSettled(client, s.id);
          expect(heard).toBe(count);
        }
        if (includes('settings'))
          expect(SettingsSchema.parse(await client.settings.update({ theme: 'light' })).theme).toBe(
            'light',
          );
      },
    );
    it.skipIf(!includes('providers') && !includes('sessions'))(
      `supports provider key checks and approval decisions${skipped.length ? ` (mock-only domains skipped: ${skipped.join(', ')})` : ''}`,
      async () => {
        const made = await make();
        cleanup = made.cleanup;
        const { client } = made;
        if (!includes('providers') || !includes('sessions')) return;
        const p = (await client.providers.list()).find((x) => x.keyStatus === 'missing');
        if (p) {
          expect((await client.providers.setKey(p.id, 'demo-key')).keyStatus).toBe('unchecked');
          expect((await client.providers.probe(p.id)).ok).toBe(true);
        }
        for (const item of await client.sessions.list()) {
          const detail = await client.sessions.get(item.id);
          const pending = detail.messages
            .flatMap((message) => message.parts.map((part) => ({ message, part })))
            .find(({ part }) => part.type === 'approval_request' && part.state === 'pending');
          if (pending?.part.type === 'approval_request') {
            await client.approvals.respond(item.id, pending.part.id, 'allow_once');
            const updated = await client.sessions.get(item.id);
            const resolved = updated.messages
              .flatMap((message) => message.parts)
              .find((part) => part.id === pending.part.id);
            expect(resolved?.type === 'approval_request' && resolved.state).toBe('allowed_once');
            break;
          }
        }
      },
    );
  });
}
