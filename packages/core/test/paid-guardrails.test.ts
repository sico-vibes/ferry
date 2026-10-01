import { rm } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { BUILTIN_PROFILES } from '@ferry/router';
import { ProfileIdSchema, ProviderIdSchema } from '@ferry/shared';
import type { MessagePart, Profile } from '@ferry/shared';
import { MemorySecretStore } from '@ferry/secrets';
import { createServices } from '../src/services.js';
import { startHarness, textTurn, waitFor } from './qa-w3-harness.js';

function requestModel(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || !('model' in body)) return undefined;
  return typeof body.model === 'string' ? body.model : undefined;
}

describe('paid-call guardrails', () => {
  it('streams an unpriced free model without paid approval or cap spend', async () => {
    const h = await startHarness({ provider: 'groq', turns: [textTurn('Free lane answer')] });
    try {
      const catalogModel = h.services.catalog.models.find(
        (item) => item.providerId === 'groq' && item.toolCalling,
      );
      expect(catalogModel).toBeDefined();
      if (!catalogModel) return;
      const model = Object.assign(catalogModel, {
        free: false,
        priceInPerM: null,
        priceOutPerM: null,
      });
      h.services.models.put(model.providerId, model);
      const profile = BUILTIN_PROFILES.find((item) => item.name === 'Auto-Free');
      expect(profile).toBeDefined();
      if (!profile) return;
      const session = await h.rpc.sessions.create({
        workspaceId: h.workspaceId,
        profileId: profile.id,
      });
      await h.rpc.models.select(session.id, model.ref);
      await h.rpc.sessions.send(session.id, { text: 'answer using the free model' });
      await waitFor(async () => {
        const detail = await h.rpc.sessions.get(session.id);
        return (
          detail.session.status === 'idle' ||
          detail.messages.some((message) =>
            message.parts.some(
              (part) => part.type === 'approval_request' && part.kind === 'paid_model',
            ),
          )
        );
      });

      const detail = await h.rpc.sessions.get(session.id);
      expect(detail.session.status).toBe('idle');
      expect(
        detail.messages.some((message) =>
          message.parts.some(
            (part) => part.type === 'approval_request' && part.kind === 'paid_model',
          ),
        ),
      ).toBe(false);
      expect(
        detail.messages.some((message) =>
          message.parts.some(
            (part) => part.type === 'text' && part.text.includes('Free lane answer'),
          ),
        ),
      ).toBe(true);
      expect(h.server.requests).toHaveLength(1);
      expect(h.services.quota.queryUsage({ sessionId: session.id })[0]?.costUsd).toBe(0);
    } finally {
      await h.close();
    }
  }, 30_000);

  it('keeps a priced model free when the router marks its provider plan free', async () => {
    const h = await startHarness({ provider: 'groq', turns: [textTurn('Free plan answer')] });
    try {
      const catalogModel = h.services.catalog.models.find(
        (item) => item.providerId === 'groq' && item.toolCalling,
      );
      expect(catalogModel).toBeDefined();
      if (!catalogModel) return;
      const model = Object.assign(catalogModel, {
        free: false,
        priceInPerM: 0.5,
        priceOutPerM: 2,
      });
      h.services.models.put(model.providerId, model);
      const profile = BUILTIN_PROFILES.find((item) => item.name === 'Auto-Free');
      expect(profile).toBeDefined();
      if (!profile) return;
      const session = await h.rpc.sessions.create({
        workspaceId: h.workspaceId,
        profileId: profile.id,
      });
      await h.rpc.models.select(session.id, model.ref);
      await h.rpc.sessions.send(session.id, { text: 'answer using the free provider plan' });
      await waitFor(async () => {
        const detail = await h.rpc.sessions.get(session.id);
        return (
          detail.session.status === 'idle' ||
          detail.messages.some((message) =>
            message.parts.some(
              (part) => part.type === 'approval_request' && part.kind === 'paid_model',
            ),
          )
        );
      });

      const detail = await h.rpc.sessions.get(session.id);
      expect(detail.session.status).toBe('idle');
      expect(
        detail.messages.some((message) =>
          message.parts.some(
            (part) => part.type === 'approval_request' && part.kind === 'paid_model',
          ),
        ),
      ).toBe(false);
      expect(h.server.requests).toHaveLength(1);
      expect(h.services.quota.queryUsage({ sessionId: session.id })[0]?.costUsd).toBe(0);
    } finally {
      await h.close();
    }
  }, 30_000);

  it('requires confirmation before the paid provider request and records spend after approval', async () => {
    const h = await startHarness({ turns: [textTurn('Paid answer')] });
    let stopped = false;
    try {
      await h.rpc.providers.setBillingEnabled(ProviderIdSchema.parse('openrouter'), true);
      const catalogModel = h.services.catalog.models.find(
        (item) => item.providerId === 'openrouter' && !item.free && item.toolCalling,
      );
      expect(catalogModel).toBeDefined();
      if (!catalogModel) return;
      const model = Object.assign(catalogModel, {
        free: false,
        tier: 'T2',
        priceInPerM: null,
        priceOutPerM: null,
      });
      const profile = BUILTIN_PROFILES.find((item) => item.name === 'Best Available');
      expect(profile).toBeDefined();
      if (!profile) return;
      const session = await h.rpc.sessions.create({
        workspaceId: h.workspaceId,
        profileId: profile.id,
      });
      await h.rpc.models.select(session.id, model.ref);
      await h.rpc.sessions.send(session.id, { text: 'use paid provider' });
      await waitFor(async () => {
        const detail = await h.rpc.sessions.get(session.id);
        return detail.messages.some((message) =>
          message.parts.some(
            (part) => part.type === 'approval_request' && part.kind === 'paid_model',
          ),
        );
      });
      expect(h.server.requests).toHaveLength(0);
      const detail = await h.rpc.sessions.get(session.id);
      const approval = detail.messages
        .flatMap((message) => message.parts)
        .find(
          (part): part is Extract<MessagePart, { type: 'approval_request' }> =>
            part.type === 'approval_request' && part.kind === 'paid_model',
        );
      expect(approval?.summary).toContain(model.name);
      expect(approval?.summary).toContain('$');
      expect(approval?.detail).toContain('conservative unknown-price allowance');
      if (!approval) return;
      await h.rpc.approvals.respond(session.id, approval.id, 'allow_once');
      await waitFor(async () => (await h.rpc.sessions.get(session.id)).session.status === 'idle');
      expect(h.server.requests).toHaveLength(1);
      const usage = h.services.quota.queryUsage({ sessionId: session.id });
      expect(usage).toHaveLength(1);
      expect(usage[0]?.costUsd).toBeGreaterThan(0);
      h.rpc.close();
      await h.host.stop();
      await h.server.stop();
      stopped = true;
      const restarted = await createServices({
        dataDir: h.dataDir,
        env: { ...process.env, NODE_ENV: 'test' },
        secrets: new MemorySecretStore(),
      });
      try {
        expect(restarted.quota.queryUsage({ sessionId: session.id })).toHaveLength(1);
      } finally {
        await restarted.dispose();
        await rm(h.root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      }
    } finally {
      if (!stopped) await h.close();
    }
  }, 30_000);

  it.each([
    { priceInPerM: 0.5, priceOutPerM: 1 },
    { priceInPerM: 0, priceOutPerM: 0 },
  ])(
    'requires confirmation before the first request for a pinned non-free OpenRouter model',
    async ({ priceInPerM, priceOutPerM }) => {
      const h = await startHarness({ turns: [textTurn('Pinned paid answer')] });
      try {
        await h.rpc.providers.setBillingEnabled(ProviderIdSchema.parse('openrouter'), true);
        const catalogModel = h.services.catalog.models.find(
          (item) => item.providerId === 'openrouter' && !item.free && item.toolCalling,
        );
        expect(catalogModel).toBeDefined();
        if (!catalogModel) return;
        const model = Object.assign(catalogModel, {
          free: false,
          priceInPerM,
          priceOutPerM,
        });
        const profile = BUILTIN_PROFILES.find((item) => item.name === 'Best Available');
        expect(profile).toBeDefined();
        if (!profile) return;
        const session = await h.rpc.sessions.create({
          workspaceId: h.workspaceId,
          profileId: profile.id,
        });
        await h.rpc.models.select(session.id, model.ref);
        await h.rpc.sessions.send(session.id, { text: 'use the pinned paid model' });
        await waitFor(async () => {
          const detail = await h.rpc.sessions.get(session.id);
          return detail.messages.some((message) =>
            message.parts.some(
              (part) => part.type === 'approval_request' && part.kind === 'paid_model',
            ),
          );
        });

        const paidRequests = () =>
          h.server.requests.filter((request) => request.url.endsWith('/chat/completions'));
        expect(paidRequests()).toHaveLength(0);
        const detail = await h.rpc.sessions.get(session.id);
        expect(detail.session.pinnedModelRef).toBe(model.ref);
        const approval = detail.messages
          .flatMap((message) => message.parts)
          .find(
            (part): part is Extract<MessagePart, { type: 'approval_request' }> =>
              part.type === 'approval_request' && part.kind === 'paid_model',
          );
        expect(approval?.summary).toContain(model.name);
        if (!approval) return;
        await h.rpc.approvals.respond(session.id, approval.id, 'allow_once');
        await waitFor(async () => (await h.rpc.sessions.get(session.id)).session.status === 'idle');
        expect(paidRequests()).toHaveLength(1);
        expect(paidRequests()[0]?.method).toBe('POST');
        expect(paidRequests()[0]?.url.endsWith('/chat/completions')).toBe(true);
        expect(requestModel(paidRequests()[0]?.body)).toBe(model.ref.replace(/^openrouter\//, ''));
      } finally {
        await h.close();
      }
    },
    30_000,
  );
  it('keeps catalog pricing through paged model listing and requires paid confirmation', async () => {
    const h = await startHarness({ turns: [textTurn('Paid answer')] });
    try {
      const providerId = ProviderIdSchema.parse('openrouter');
      await h.rpc.providers.setBillingEnabled(providerId, true);
      const catalogModel = h.services.catalog.models.find(
        (item) =>
          item.providerId === providerId &&
          !item.free &&
          item.toolCalling &&
          (item.priceInPerM ?? 0) > 0 &&
          (item.priceOutPerM ?? 0) > 0,
      );
      expect(catalogModel).toBeDefined();
      if (!catalogModel) return;
      const cachedModel = {
        ...catalogModel,
        free: false,
        priceInPerM: 0,
        priceOutPerM: 0,
      };
      h.services.models.replace(providerId, [cachedModel]);
      const provider = h.services.providers.get(providerId);
      expect(provider).toBeDefined();
      if (!provider) return;
      h.services.providers.put({
        ...provider,
        availableModels: [cachedModel],
        modelCount: 1,
        modelsVerifiedAt: h.services.clock.now().toISOString(),
      });

      const page = await h.rpc.models.page({ filters: { providerId }, limit: 2_000 });
      const model = page.items.find((item) => item.ref === catalogModel.ref);
      expect(model).toMatchObject({
        ref: catalogModel.ref,
        free: false,
        priceInPerM: catalogModel.priceInPerM,
        priceOutPerM: catalogModel.priceOutPerM,
      });
      if (!model) return;
      expect(model.ref).not.toMatch(/:free(?:$|:)/i);

      h.services.env.NODE_ENV = 'production';
      const profile = BUILTIN_PROFILES.find((item) => item.name === 'Best Available');
      expect(profile).toBeDefined();
      if (!profile) return;
      const session = await h.rpc.sessions.create({
        workspaceId: h.workspaceId,
        profileId: profile.id,
      });
      await h.rpc.models.select(session.id, model.ref);
      await h.rpc.sessions.send(session.id, { text: 'use the priced paged model' });
      await waitFor(async () => {
        const detail = await h.rpc.sessions.get(session.id);
        return detail.messages.some((message) =>
          message.parts.some(
            (part) => part.type === 'approval_request' && part.kind === 'paid_model',
          ),
        );
      });

      const requests = h.server.requests.filter((request) =>
        request.url.endsWith('/chat/completions'),
      );
      expect(requests).toHaveLength(0);
      const detail = await h.rpc.sessions.get(session.id);
      const approval = detail.messages
        .flatMap((message) => message.parts)
        .find(
          (part): part is Extract<MessagePart, { type: 'approval_request' }> =>
            part.type === 'approval_request' && part.kind === 'paid_model',
        );
      expect(approval?.summary).toContain(model.name);
      expect(approval?.detail).not.toContain('unknown-price allowance');
    } finally {
      await h.close();
    }
  }, 30_000);
  it('records the approved preflight estimate when a paid stream omits token usage', async () => {
    const h = await startHarness({ turns: [textTurn('Paid stream without usage')] });
    try {
      await h.rpc.providers.setBillingEnabled(ProviderIdSchema.parse('openrouter'), true);
      const catalogModel = h.services.catalog.models.find(
        (item) => item.providerId === 'openrouter' && !item.free && item.toolCalling,
      );
      expect(catalogModel).toBeDefined();
      if (!catalogModel) return;
      const model = Object.assign(catalogModel, {
        free: false,
        tier: 'T2',
        priceInPerM: 1,
        priceOutPerM: 2,
      });
      const profile = BUILTIN_PROFILES.find((item) => item.name === 'Best Available');
      expect(profile).toBeDefined();
      if (!profile) return;
      const session = await h.rpc.sessions.create({
        workspaceId: h.workspaceId,
        profileId: profile.id,
      });
      await h.rpc.models.select(session.id, model.ref);
      await h.rpc.sessions.send(session.id, { text: 'approve the estimated paid request' });
      await waitFor(async () => {
        const detail = await h.rpc.sessions.get(session.id);
        return detail.messages.some((message) =>
          message.parts.some(
            (part) => part.type === 'approval_request' && part.kind === 'paid_model',
          ),
        );
      });
      const detail = await h.rpc.sessions.get(session.id);
      const approval = detail.messages
        .flatMap((message) => message.parts)
        .find(
          (part): part is Extract<MessagePart, { type: 'approval_request' }> =>
            part.type === 'approval_request' && part.kind === 'paid_model',
        );
      expect(approval?.summary).toContain('OpenRouter');
      expect(approval?.summary.toLowerCase()).not.toContain('free models');
      if (!approval) return;
      await h.rpc.approvals.respond(session.id, approval.id, 'allow_once');
      await waitFor(async () => (await h.rpc.sessions.get(session.id)).session.status === 'idle');

      const usage = h.services.quota.queryUsage({ sessionId: session.id });
      expect(usage).toHaveLength(1);
      expect(usage[0]?.costUsd).toBeGreaterThan(0);
      expect(usage[0]?.headers?.costEstimate).toBe('approved-preflight-estimate');
    } finally {
      await h.close();
    }
  }, 30_000);

  it('declining paid confirmation makes no paid provider request', async () => {
    const h = await startHarness({ turns: [textTurn('must not run')] });
    try {
      await h.rpc.providers.setBillingEnabled(ProviderIdSchema.parse('openrouter'), true);
      const model = h.services.catalog.models.find(
        (item) => item.providerId === 'openrouter' && !item.free && item.toolCalling,
      );
      expect(model).toBeDefined();
      if (!model) return;
      Object.assign(model, { free: false, tier: 'T2', priceInPerM: null, priceOutPerM: null });
      const profile = BUILTIN_PROFILES.find((item) => item.name === 'Best Available');
      expect(profile).toBeDefined();
      if (!profile) return;
      const session = await h.rpc.sessions.create({
        workspaceId: h.workspaceId,
        profileId: profile.id,
      });
      await h.rpc.models.select(session.id, model.ref);
      await h.rpc.sessions.send(session.id, { text: 'decline the paid provider' });
      await waitFor(async () => {
        const detail = await h.rpc.sessions.get(session.id);
        return detail.messages.some((message) =>
          message.parts.some(
            (part) => part.type === 'approval_request' && part.kind === 'paid_model',
          ),
        );
      });
      const detail = await h.rpc.sessions.get(session.id);
      const approval = detail.messages
        .flatMap((message) => message.parts)
        .find(
          (part): part is Extract<MessagePart, { type: 'approval_request' }> =>
            part.type === 'approval_request' && part.kind === 'paid_model',
        );
      expect(approval).toBeDefined();
      if (!approval) return;
      await h.rpc.approvals.respond(session.id, approval.id, 'deny');
      await waitFor(async () => (await h.rpc.sessions.get(session.id)).session.status === 'idle');
      expect(h.server.requests).toHaveLength(0);
      const final = await h.rpc.sessions.get(session.id);
      expect(
        final.messages.some((message) =>
          message.parts.some((part) => part.type === 'error' && part.message.includes('declined')),
        ),
      ).toBe(true);
    } finally {
      await h.close();
    }
  }, 30_000);

  it('hard-stops at a zero daily profile cap without a provider request', async () => {
    const h = await startHarness({ turns: [textTurn('must not run')] });
    try {
      await h.rpc.providers.setBillingEnabled(ProviderIdSchema.parse('openrouter'), true);
      const catalogModel = h.services.catalog.models.find(
        (item) => item.providerId === 'openrouter' && !item.free && item.toolCalling,
      );
      expect(catalogModel).toBeDefined();
      if (!catalogModel) return;
      const model = Object.assign(catalogModel, {
        free: false,
        tier: 'T2',
        priceInPerM: null,
        priceOutPerM: null,
      });
      const base = BUILTIN_PROFILES.find((item) => item.name === 'Best Available');
      expect(base).toBeDefined();
      if (!base) return;
      const profile: Profile = {
        ...base,
        id: ProfileIdSchema.parse('profile_paid_cap_test'),
        name: 'Paid Cap Test',
        builtin: false,
        caps: { ...base.caps, dailyUsd: 0 },
      };
      await h.rpc.profiles.save(profile);
      const session = await h.rpc.sessions.create({
        workspaceId: h.workspaceId,
        profileId: profile.id,
      });
      await h.rpc.models.select(session.id, model.ref);
      await h.rpc.sessions.send(session.id, { text: 'hit the paid cap' });
      await waitFor(async () => (await h.rpc.sessions.get(session.id)).session.status === 'idle');
      expect(h.server.requests).toHaveLength(0);
      const detail = await h.rpc.sessions.get(session.id);
      expect(
        detail.messages.some((message) =>
          message.parts.some(
            (part) => part.type === 'error' && part.message.includes('Paid cap reached'),
          ),
        ),
      ).toBe(true);
    } finally {
      await h.close();
    }
  }, 30_000);

  it('hard-stops a paid fallback after a free model hands off at the cap', async () => {
    const h = await startHarness({
      turns: [
        {
          status: 429,
          body: { error: { message: 'scripted rate limit', type: 'rate_limit_error' } },
        },
        textTurn('Paid fallback must not run'),
      ],
    });
    try {
      await h.rpc.providers.setBillingEnabled(ProviderIdSchema.parse('openrouter'), true);
      const settings = await h.rpc.settings.get();
      await h.rpc.settings.update({
        routing: { ...settings.routing, quotaReservations: false },
      });
      const catalogFreeModel = h.services.catalog.models.find(
        (item) =>
          item.providerId === 'openrouter' && item.ref.endsWith(':free') && item.toolCalling,
      );
      const catalogPaidModel = h.services.catalog.models.find(
        (item) => item.providerId === 'openrouter' && !item.free && item.toolCalling,
      );
      expect(catalogFreeModel).toBeDefined();
      expect(catalogPaidModel).toBeDefined();
      if (!catalogFreeModel || !catalogPaidModel) return;
      const freeModelPattern = catalogFreeModel.ref.replace(/^openrouter\//, '');
      const paidModelPattern = catalogPaidModel.ref.replace(/^openrouter\//, '');
      h.services.models.replace('openrouter', [catalogFreeModel, catalogPaidModel]);
      const base = BUILTIN_PROFILES.find((item) => item.name === 'Best Available');
      expect(base).toBeDefined();
      if (!base) return;
      const profile: Profile = {
        ...base,
        id: ProfileIdSchema.parse('profile_paid_fallback_cap_test'),
        name: 'Paid Fallback Cap Test',
        builtin: false,
        caps: { ...base.caps, dailyUsd: 0 },
        roles: { ...base.roles, enabled: false },
        fallbackChain: [
          { provider: ProviderIdSchema.parse('openrouter'), patterns: [freeModelPattern] },
          { provider: ProviderIdSchema.parse('openrouter'), patterns: [paidModelPattern] },
        ],
      };
      await h.rpc.profiles.save(profile);
      const session = await h.rpc.sessions.create({
        workspaceId: h.workspaceId,
        profileId: profile.id,
      });
      await h.rpc.sessions.send(session.id, { text: 'try free, then hit the paid cap' });
      await waitFor(async () => {
        const detail = await h.rpc.sessions.get(session.id);
        return detail.messages.some((message) =>
          message.parts.some(
            (part) => part.type === 'error' && part.message.includes('Paid cap reached'),
          ),
        );
      });

      const requestModels = h.server.requests
        .map((request) => requestModel(request.body))
        .filter((model): model is string => model !== undefined);
      expect(requestModels).toEqual([freeModelPattern]);
      const detail = await h.rpc.sessions.get(session.id);
      expect(
        detail.messages.some((message) =>
          message.parts.some(
            (part) => part.type === 'error' && part.message.includes('Paid cap reached'),
          ),
        ),
      ).toBe(true);
      expect(
        detail.messages.some((message) =>
          message.parts.some(
            (part) => part.type === 'handoff_marker' && part.reason === 'rate_limit',
          ),
        ),
      ).toBe(true);
    } finally {
      await h.close();
    }
  }, 30_000);

  it('blocks the paid editor role after a free planner reaches the cap', async () => {
    const plan = JSON.stringify({
      files: [{ path: 'README.md', intent: 'Document the requested change' }],
      changes: [{ path: 'README.md', instructions: 'Add a short note' }],
    });
    const h = await startHarness({ turns: [textTurn(plan), textTurn('Paid editor must not run')] });
    try {
      await h.rpc.providers.setBillingEnabled(ProviderIdSchema.parse('openrouter'), true);
      const freeModel = h.services.catalog.models.find(
        (item) =>
          item.providerId === 'openrouter' && item.ref.endsWith(':free') && item.toolCalling,
      );
      const paidModel = h.services.catalog.models.find(
        (item) => item.providerId === 'openrouter' && !item.free && item.toolCalling,
      );
      expect(freeModel).toBeDefined();
      expect(paidModel).toBeDefined();
      if (!freeModel || !paidModel) return;
      const base = BUILTIN_PROFILES.find((item) => item.name === 'Best Available');
      expect(base).toBeDefined();
      if (!base) return;
      const profile: Profile = {
        ...base,
        id: ProfileIdSchema.parse('profile_paid_role_cap_test'),
        name: 'Paid Role Cap Test',
        builtin: false,
        caps: { ...base.caps, dailyUsd: 0 },
        roles: {
          ...base.roles,
          enabled: true,
          plannerModelRef: freeModel.ref,
          editorModelRef: paidModel.ref,
        },
      };
      await h.rpc.profiles.save(profile);
      const session = await h.rpc.sessions.create({
        workspaceId: h.workspaceId,
        profileId: profile.id,
      });
      await h.rpc.sessions.send(session.id, { text: 'plan and then edit this workspace' });
      await waitFor(async () => {
        const detail = await h.rpc.sessions.get(session.id);
        return detail.messages.some((message) =>
          message.parts.some(
            (part) => part.type === 'error' && part.message.includes('Paid cap reached'),
          ),
        );
      });

      const requestModels = h.server.requests
        .map((request) => requestModel(request.body))
        .filter((model): model is string => model !== undefined);
      expect(requestModels).toEqual([freeModel.ref.replace(/^openrouter\//, '')]);
      const detail = await h.rpc.sessions.get(session.id);
      expect(
        detail.messages.some((message) =>
          message.parts.some(
            (part) => part.type === 'error' && part.message.includes('Paid cap reached'),
          ),
        ),
      ).toBe(true);
    } finally {
      await h.close();
    }
  }, 30_000);

  it('allows a free model after a paid model hands off', async () => {
    const h = await startHarness({
      turns: [
        {
          status: 429,
          body: { error: { message: 'scripted rate limit', type: 'rate_limit_error' } },
        },
        textTurn('Free fallback answer'),
      ],
    });
    try {
      await h.rpc.providers.setBillingEnabled(ProviderIdSchema.parse('openrouter'), true);
      const settings = await h.rpc.settings.get();
      await h.rpc.settings.update({
        routing: { ...settings.routing, quotaReservations: false },
      });
      const catalogFreeModel = h.services.catalog.models.find(
        (item) =>
          item.providerId === 'openrouter' && item.ref.endsWith(':free') && item.toolCalling,
      );
      const catalogPaidModel = h.services.catalog.models.find(
        (item) => item.providerId === 'openrouter' && !item.free && item.toolCalling,
      );
      expect(catalogFreeModel).toBeDefined();
      expect(catalogPaidModel).toBeDefined();
      if (!catalogFreeModel || !catalogPaidModel) return;
      const base = BUILTIN_PROFILES.find((item) => item.name === 'Best Available');
      expect(base).toBeDefined();
      if (!base) return;
      const paidModelPattern = catalogPaidModel.ref.replace(/^openrouter\//, '');
      const freeModelPattern = catalogFreeModel.ref.replace(/^openrouter\//, '');
      h.services.models.replace('openrouter', [catalogFreeModel, catalogPaidModel]);
      const profile: Profile = {
        ...base,
        id: ProfileIdSchema.parse('profile_paid_free_fallback_test'),
        name: 'Paid Free Fallback Test',
        builtin: false,
        roles: { ...base.roles, enabled: false },
        fallbackChain: [
          { provider: ProviderIdSchema.parse('openrouter'), patterns: [paidModelPattern] },
          { provider: ProviderIdSchema.parse('openrouter'), patterns: [freeModelPattern] },
        ],
      };
      await h.rpc.profiles.save(profile);
      const session = await h.rpc.sessions.create({
        workspaceId: h.workspaceId,
        profileId: profile.id,
      });
      await h.rpc.sessions.send(session.id, { text: 'fall back to a free model' });
      await waitFor(async () => {
        const detail = await h.rpc.sessions.get(session.id);
        return detail.messages.some((message) =>
          message.parts.some(
            (part) => part.type === 'approval_request' && part.kind === 'paid_model',
          ),
        );
      });
      const detail = await h.rpc.sessions.get(session.id);
      const approval = detail.messages
        .flatMap((message) => message.parts)
        .find(
          (part): part is Extract<MessagePart, { type: 'approval_request' }> =>
            part.type === 'approval_request' && part.kind === 'paid_model',
        );
      expect(h.server.requests).toHaveLength(0);
      if (!approval) return;
      await h.rpc.approvals.respond(session.id, approval.id, 'allow_once');
      await waitFor(async () => {
        const current = await h.rpc.sessions.get(session.id);
        return current.session.status === 'idle';
      });

      const requestModels = h.server.requests
        .map((request) => requestModel(request.body))
        .filter((model): model is string => model !== undefined);
      expect(requestModels).toEqual([paidModelPattern, freeModelPattern]);
      const final = await h.rpc.sessions.get(session.id);
      expect(
        final.messages.some((message) =>
          message.parts.some(
            (part) => part.type === 'handoff_marker' && part.reason === 'rate_limit',
          ),
        ),
      ).toBe(true);
      expect(
        final.messages.some((message) =>
          message.parts.some(
            (part) => part.type === 'text' && part.text.includes('Free fallback answer'),
          ),
        ),
      ).toBe(true);
    } finally {
      await h.close();
    }
  }, 30_000);

  it('hard-stops at a zero session profile cap without a provider request', async () => {
    const h = await startHarness({ turns: [textTurn('must not run')] });
    try {
      await h.rpc.providers.setBillingEnabled(ProviderIdSchema.parse('openrouter'), true);
      const catalogModel = h.services.catalog.models.find(
        (item) => item.providerId === 'openrouter' && !item.free && item.toolCalling,
      );
      expect(catalogModel).toBeDefined();
      if (!catalogModel) return;
      const model = Object.assign(catalogModel, {
        free: false,
        tier: 'T2',
        priceInPerM: null,
        priceOutPerM: null,
      });
      const base = BUILTIN_PROFILES.find((item) => item.name === 'Best Available');
      expect(base).toBeDefined();
      if (!base) return;
      const profile: Profile = {
        ...base,
        id: ProfileIdSchema.parse('profile_paid_cap_test'),
        name: 'Paid Cap Test',
        builtin: false,
        caps: { ...base.caps, sessionUsd: 0 },
      };
      await h.rpc.profiles.save(profile);
      const session = await h.rpc.sessions.create({
        workspaceId: h.workspaceId,
        profileId: profile.id,
      });
      await h.rpc.models.select(session.id, model.ref);
      await h.rpc.sessions.send(session.id, { text: 'hit the paid cap' });
      await waitFor(async () => (await h.rpc.sessions.get(session.id)).session.status === 'idle');
      expect(h.server.requests).toHaveLength(0);
      const detail = await h.rpc.sessions.get(session.id);
      expect(
        detail.messages.some((message) =>
          message.parts.some(
            (part) =>
              part.type === 'error' &&
              part.message.includes('Paid cap reached') &&
              part.message.includes('this session'),
          ),
        ),
      ).toBe(true);
    } finally {
      await h.close();
    }
  }, 30_000);
});
