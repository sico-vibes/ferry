import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ProviderLimitsSchema, SessionSchema, type ProviderLimits } from '@ferry/shared';
import { createCoreHost } from '../src/index.js';

vi.setConfig({ testTimeout: 30_000 });

describe('effort persistence and honest limit RPCs', () => {
  it('persists effort across restarts, resets it to provider default, and emits session.updated', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ferry-effort-'));
    const workspacePath = join(root, 'workspace');
    await mkdir(workspacePath);
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network forbidden'));
    let host = await createCoreHost({ dataDir: join(root, 'data') });
    try {
      const dispatch = (method: string, params: unknown[] = []) =>
        host.dispatch({ jsonrpc: '2.0', id: 'test', method, params });
      const workspace = (await dispatch('workspaces.open', [workspacePath])) as { id: string };
      const created = SessionSchema.parse(
        await dispatch('sessions.create', [{ workspaceId: workspace.id }]),
      );
      const events: unknown[] = [];
      host.onEvent((method, payload) => {
        if (method === 'session.updated') events.push(payload);
      });
      expect(
        SessionSchema.parse(await dispatch('sessions.setEffort', [created.id, 'xhigh'])).effort,
      ).toBe('xhigh');
      expect(events).toEqual([expect.objectContaining({ id: created.id, effort: 'xhigh' })]);
      await host.stop();
      host = await createCoreHost({ dataDir: join(root, 'data') });
      const detail = (await dispatch('sessions.get', [created.id])) as { session: unknown };
      expect(SessionSchema.parse(detail.session).effort).toBe('xhigh');
      expect(
        SessionSchema.parse(await dispatch('sessions.setEffort', [created.id, null])).effort,
      ).toBeNull();
      await expect(dispatch('sessions.setEffort', [created.id, 'invalid'])).rejects.toThrow();
      const limits = (await dispatch('quota.limits')) as ProviderLimits[];
      expect(limits.length).toBeGreaterThan(0);
      limits.forEach((row) => ProviderLimitsSchema.parse(row));
      expect(limits.find((row) => row.providerId === 'openai')?.state).toBe('paid_no_limit');
    } finally {
      await host.stop();
      fetch.mockRestore();
      await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });
  it('emits quota.limits.updated only when daily/monthly limits change', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ferry-limits-'));
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network forbidden'));
    const host = await createCoreHost({ dataDir: join(root, 'data') });
    try {
      const services = host.options.services;
      if (!services) throw new Error('Missing services');
      const update = new Promise<unknown>((resolve) =>
        host.onEvent((method, payload) => {
          if (method === 'quota.limits.updated') resolve(payload);
        }),
      );
      services.quota.observe({
        id: 'fixture-limit',
        providerId: 'openai' as import('@ferry/shared').ProviderId,
        windowId: 'openai:provider:*:requests:fixed_daily',
        period: 'day',
        metric: 'requests',
        limit: 100,
        remaining: 90,
        source: 'header',
        observedAt: services.clock.now().toISOString(),
        resetAt: new Date(Date.now() + 86_400_000).toISOString(),
      });
      const value = (await update) as ProviderLimits[];
      expect(value.find((row) => row.providerId === 'openai')).toMatchObject({
        state: 'known',
        windows: [expect.objectContaining({ remaining: 90, source: 'header' })],
      });
    } finally {
      await host.stop();
      fetch.mockRestore();
      await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });
});
