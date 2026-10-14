import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemorySecretStore } from '@ferry/secrets';
import { RequestRepository, backfillSessionModelUsage } from '@ferry/storage';
import {
  MessageSchema,
  ModelRefSchema,
  PartIdSchema,
  ProfileIdSchema,
  SessionIdSchema,
  SessionSchema,
  type Message,
  type ModelRef,
  type PartId,
  type Session,
  type SessionId,
} from '@ferry/shared';
import { createServices, type FerryServices } from '../src/services.js';
import {
  lastRespondingModel,
  pendingApprovalSummary,
  sessionModelUsage,
  sessionSummariesWithLastReply,
  sessionSummaryWithLastReply,
} from '../src/session-insights.js';

vi.setConfig({ testTimeout: 30_000 });

const MODEL_A = ModelRefSchema.parse('openai/gpt-5');
const MODEL_B = ModelRefSchema.parse('anthropic/claude-opus-4');
const PRODUCED = ModelRefSchema.parse('opencode-cli/opencode-go/deepseek-v4.1-flash');
const VALID_ACCOUNT_KEY = 'openai:abcdef012345';

const cleanups: (() => Promise<void>)[] = [];
let sequence = 0;

afterEach(async () => {
  const pending = cleanups.splice(0);
  for (const cleanup of pending) await cleanup();
});

async function startServices(): Promise<FerryServices> {
  const dir = await mkdtemp(join(tmpdir(), 'ferry-insights-'));
  const services = await createServices({
    dataDir: dir,
    env: { NODE_ENV: 'test' },
    secrets: new MemorySecretStore(),
  });
  cleanups.push(async () => {
    await services.dispose();
    await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });
  return services;
}

function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}_${String(sequence).padStart(5, '0')}`;
}

function nextPartId(): PartId {
  return PartIdSchema.parse(nextId('part'));
}

function makeSession(id: string, overrides: Partial<Session> = {}): Session {
  return SessionSchema.parse({
    id: SessionIdSchema.parse(id),
    workspaceId: null,
    title: `Session ${id}`,
    preview: '',
    profileId: ProfileIdSchema.parse('profile_builtin_direct'),
    modelRef: null,
    pinnedModelRef: null,
    starred: false,
    pinned: false,
    status: 'idle',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    agentEvents: [],
    ...overrides,
  });
}

function message(
  sessionId: SessionId,
  role: Message['role'],
  parts: Message['parts'],
  modelRef: ModelRef | null,
  createdAt = '2026-01-01T00:00:00.000Z',
): Message {
  return MessageSchema.parse({
    id: nextId('message'),
    sessionId,
    role,
    createdAt,
    modelRef,
    parts,
  });
}

function textPart(text: string): Message['parts'][number] {
  return { type: 'text', id: nextPartId(), text };
}

function producedTextPart(text: string, producedBy: ModelRef): Message['parts'][number] {
  return { type: 'text', id: nextPartId(), text, producedBy };
}

function reasoningPart(text: string, producedBy?: ModelRef): Message['parts'][number] {
  return { type: 'reasoning', id: nextPartId(), text, ...(producedBy ? { producedBy } : {}) };
}

function toolCallPart(output: string | null, producedBy?: ModelRef): Message['parts'][number] {
  return {
    type: 'tool_call',
    id: nextPartId(),
    tool: 'write_file',
    title: 'Write file',
    args: {},
    status: output === null ? 'running' : 'succeeded',
    output:
      output === null
        ? null
        : {
            text: output,
            filtered: false,
            originalTokens: null,
            filteredTokens: null,
            recoveryHandle: null,
          },
    changes: [],
    durationMs: null,
    ...(producedBy ? { producedBy } : {}),
  };
}

function errorPart(text: string): Message['parts'][number] {
  return { type: 'error', id: nextPartId(), message: text, kind: 'internal' };
}

function approvalPart(
  state: 'pending' | 'allowed_once' | 'allowed_always' | 'denied',
): Extract<Message['parts'][number], { type: 'approval_request' }> {
  return {
    type: 'approval_request',
    id: nextPartId(),
    kind: 'command',
    summary: `Run a command (${state})`,
    detail: 'rm -rf build',
    risk: 'medium',
    state,
  };
}

function expectNotFound(run: () => unknown): void {
  try {
    run();
  } catch (error) {
    expect(error).toMatchObject({ kind: 'not_found' });
    return;
  }
  throw new Error('expected a not_found error');
}

function seedUsageRow(
  services: FerryServices,
  row: {
    sessionId: string;
    modelRef: string;
    providerId: string | null;
    connectionId?: string | null;
    accountKey?: string | null;
    requests?: number;
    inputTokens?: number | null;
    outputTokens?: number | null;
    cachedTokens?: number | null;
    reasoningTokens?: number | null;
    lastUsedAt?: string;
    unreportedRequests?: number;
    provenanceKnown?: boolean;
  },
): void {
  const inputTokens = row.inputTokens ?? null;
  const outputTokens = row.outputTokens ?? null;
  const cachedTokens = row.cachedTokens ?? null;
  const reasoningTokens = row.reasoningTokens ?? null;
  services.db.client
    .prepare(
      `INSERT INTO session_model_usage (session_id,model_ref,provider_id,connection_id,account_key,provenance_known,requests,input_tokens,output_tokens,cached_tokens,reasoning_tokens,input_reported,output_reported,cached_reported,reasoning_reported,unreported_requests,last_used_at)
       VALUES (@sessionId,@modelRef,@providerId,@connectionId,@accountKey,@provenanceKnown,@requests,@inputTokens,@outputTokens,@cachedTokens,@reasoningTokens,@inputReported,@outputReported,@cachedReported,@reasoningReported,@unreportedRequests,@lastUsedAt)`,
    )
    .run({
      sessionId: row.sessionId,
      modelRef: row.modelRef,
      providerId: row.providerId ?? '',
      connectionId: row.connectionId ?? '',
      accountKey: row.accountKey ?? '',
      provenanceKnown: row.provenanceKnown === false ? 0 : 1,
      requests: row.requests ?? 1,
      inputTokens,
      outputTokens,
      cachedTokens,
      reasoningTokens,
      inputReported: inputTokens === null ? 0 : 1,
      outputReported: outputTokens === null ? 0 : 1,
      cachedReported: cachedTokens === null ? 0 : 1,
      reasoningReported: reasoningTokens === null ? 0 : 1,
      unreportedRequests: row.unreportedRequests ?? 0,
      lastUsedAt: row.lastUsedAt ?? '2026-01-01T00:00:00.000Z',
    });
}

function seedRequest(
  services: FerryServices,
  input: {
    id: string;
    ts: string;
    provider: string;
    model: string;
    sessionId: string;
    inputTokens: number | null;
    outputTokens: number | null;
  },
): void {
  services.db.client
    .prepare(
      `INSERT INTO requests (id,ts,provider,model,session_id,input_tokens,output_tokens,status)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    .run(
      input.id,
      input.ts,
      input.provider,
      input.model,
      input.sessionId,
      input.inputTokens,
      input.outputTokens,
      'ok',
    );
}

describe('sessionModelUsage', () => {
  it('throws not_found for a missing session instead of reading another conversation', async () => {
    const services = await startServices();
    const session = makeSession('session_owner');
    services.sessions.put(session);
    new RequestRepository(services.db.client).put({
      id: 'req_owner',
      ts: '2026-01-01T00:00:00.000Z',
      provider: 'openai',
      model: 'gpt-5',
      session_id: session.id,
      input_tokens: 10,
      output_tokens: 4,
      status: 'ok',
    });
    expectNotFound(() => sessionModelUsage(services, SessionIdSchema.parse('session_absent')));
    expect(sessionModelUsage(services, session.id).totals.requests).toBe(1);
  });

  it('canonicalizes a legacy bare model id with its provider into a qualified ref', async () => {
    const services = await startServices();
    const session = makeSession('session_legacy');
    services.sessions.put(session);
    new RequestRepository(services.db.client).put({
      id: 'req_legacy',
      ts: '2026-01-01T00:00:00.000Z',
      provider: 'openai',
      model: 'gpt-5',
      session_id: session.id,
      input_tokens: 10,
      output_tokens: 4,
      status: 'ok',
    });
    const usage = sessionModelUsage(services, session.id);
    expect(usage.models).toHaveLength(1);
    expect(usage.models[0]).toMatchObject({
      modelRef: 'openai/gpt-5',
      providerId: 'openai',
      requests: 1,
      inputTokens: 10,
      outputTokens: 4,
    });
  });

  it('merges a legacy bare id with its already-qualified alias into one row', async () => {
    const services = await startServices();
    const session = makeSession('session_alias');
    services.sessions.put(session);
    const requests = new RequestRepository(services.db.client);
    requests.put({
      id: 'req_bare',
      ts: '2026-01-01T00:00:00.000Z',
      provider: 'openai',
      model: 'gpt-5',
      session_id: session.id,
      input_tokens: 10,
      output_tokens: 4,
      status: 'ok',
    });
    requests.put({
      id: 'req_qualified',
      ts: '2026-01-01T00:00:05.000Z',
      provider: 'openai',
      model: 'openai/gpt-5',
      session_id: session.id,
      input_tokens: 5,
      output_tokens: 1,
      status: 'ok',
    });
    const usage = sessionModelUsage(services, session.id);
    expect(usage.models).toHaveLength(1);
    expect(usage.models[0]).toMatchObject({
      modelRef: 'openai/gpt-5',
      requests: 2,
      inputTokens: 15,
      outputTokens: 5,
    });
    expect(usage.totals.requests).toBe(2);
  });

  it('groups an unknown-provenance alias separately from a known-provenance alias', async () => {
    const services = await startServices();
    const session = makeSession('session_alias_provenance');
    services.sessions.put(session);
    seedUsageRow(services, {
      sessionId: session.id,
      modelRef: 'gpt-5',
      providerId: 'openai',
      connectionId: null,
      accountKey: null,
      inputTokens: 4,
      outputTokens: 2,
    });
    seedUsageRow(services, {
      sessionId: session.id,
      modelRef: 'openai/gpt-5',
      providerId: 'openai',
      connectionId: 'conn-1',
      accountKey: VALID_ACCOUNT_KEY,
      inputTokens: 1,
      outputTokens: 1,
    });
    const usage = sessionModelUsage(services, session.id);
    // Unknown (null) provenance is its own bucket and is never folded into the known row.
    expect(usage.models).toHaveLength(2);
    expect(usage.models).toContainEqual(
      expect.objectContaining({
        modelRef: 'openai/gpt-5',
        connectionId: null,
        accountKey: null,
        requests: 1,
        inputTokens: 4,
        outputTokens: 2,
      }),
    );
    expect(usage.models).toContainEqual(
      expect.objectContaining({
        modelRef: 'openai/gpt-5',
        connectionId: 'conn-1',
        accountKey: VALID_ACCOUNT_KEY,
        requests: 1,
        inputTokens: 1,
        outputTokens: 1,
      }),
    );
  });

  it('keeps the same model split across accounts as distinct model entries', async () => {
    const services = await startServices();
    const session = makeSession('session_split_accounts');
    services.sessions.put(session);
    const requests = new RequestRepository(services.db.client);
    requests.put({
      id: 'split-a',
      ts: '2026-01-01T00:00:00.000Z',
      provider: 'openai',
      model: 'gpt-5',
      session_id: session.id,
      connection_id: 'conn-a',
      account_key: 'openai:aaaaaaaaaaaa',
      input_tokens: 10,
      output_tokens: 2,
      status: 'ok',
    });
    requests.put({
      id: 'split-b',
      ts: '2026-01-01T00:00:05.000Z',
      provider: 'openai',
      model: 'gpt-5',
      session_id: session.id,
      connection_id: 'conn-b',
      account_key: 'openai:bbbbbbbbbbbb',
      input_tokens: 20,
      output_tokens: 4,
      status: 'ok',
    });
    const usage = sessionModelUsage(services, session.id);
    expect(usage.models).toHaveLength(2);
    expect(usage.models.every((model) => model.modelRef === 'openai/gpt-5')).toBe(true);
    expect(usage.models.map((model) => model.accountKey).sort()).toEqual([
      'openai:aaaaaaaaaaaa',
      'openai:bbbbbbbbbbbb',
    ]);
    expect(usage.totals).toMatchObject({ requests: 2, inputTokens: 30, outputTokens: 6 });
  });

  it('keeps an unknown partial remainder alongside the exact covered row', async () => {
    const services = await startServices();
    const session = makeSession('session_partial');
    services.sessions.put(session);
    seedUsageRow(services, {
      sessionId: session.id,
      modelRef: 'openai/gpt-5',
      providerId: 'openai',
      connectionId: 'conn-ledger',
      accountKey: VALID_ACCOUNT_KEY,
      inputTokens: 10,
      outputTokens: 2,
    });
    seedUsageRow(services, {
      sessionId: session.id,
      modelRef: 'openai/gpt-5',
      providerId: 'openai',
      connectionId: 'conn-legacy',
      accountKey: 'openai:cccccccccccc',
      requests: 2,
      inputTokens: 20,
      outputTokens: 4,
      provenanceKnown: false,
    });
    const usage = sessionModelUsage(services, session.id);
    // The exact covered row and the honest unknown remainder stay distinct entries.
    expect(usage.models).toHaveLength(2);
    expect(usage.models).toContainEqual(
      expect.objectContaining({ connectionId: 'conn-ledger', requests: 1 }),
    );
    expect(usage.models).toContainEqual(
      expect.objectContaining({ connectionId: 'conn-legacy', requests: 2 }),
    );
    // No token is lost and the uncertainty is reported rather than hidden.
    expect(usage.totals).toMatchObject({ requests: 3, inputTokens: 30, outputTokens: 6 });
    expect(usage.coverage.missing).toBe(true);
  });

  it('never collapses differently evidenced connection/account alias rows', async () => {
    const services = await startServices();
    const session = makeSession('session_alias_conflict');
    services.sessions.put(session);
    seedUsageRow(services, {
      sessionId: session.id,
      modelRef: 'gpt-5',
      providerId: 'openai',
      connectionId: 'conn-a',
      accountKey: 'openai:abcdef012345',
      inputTokens: 4,
      outputTokens: 2,
    });
    seedUsageRow(services, {
      sessionId: session.id,
      modelRef: 'openai/gpt-5',
      providerId: 'openai',
      connectionId: 'conn-b',
      accountKey: 'openai:001122334455',
      inputTokens: 1,
      outputTokens: 1,
    });
    const usage = sessionModelUsage(services, session.id);
    expect(usage.models).toHaveLength(2);
    expect(usage.models).toContainEqual(
      expect.objectContaining({ modelRef: 'openai/gpt-5', connectionId: 'conn-a' }),
    );
    expect(usage.models).toContainEqual(
      expect.objectContaining({ modelRef: 'openai/gpt-5', connectionId: 'conn-b' }),
    );
    // The distinction is preserved, but the summed totals stay consistent with both rows.
    expect(usage.totals).toMatchObject({ requests: 2, inputTokens: 5, outputTokens: 3 });
  });

  it('keeps a representable unknown ref for empty or malformed legacy keys without leaking them', async () => {
    const services = await startServices();
    const session = makeSession('session_malformed');
    services.sessions.put(session);
    seedUsageRow(services, {
      sessionId: session.id,
      modelRef: '',
      providerId: 'openai',
      inputTokens: 6,
      outputTokens: 2,
    });
    seedUsageRow(services, {
      sessionId: session.id,
      modelRef: 'secret-token\nwith-newline',
      providerId: 'openai',
      inputTokens: 3,
      outputTokens: 1,
    });
    const usage = sessionModelUsage(services, session.id);
    expect(usage.models).toHaveLength(2);
    for (const model of usage.models) {
      expect(model.modelRef.startsWith('unknown/')).toBe(true);
      expect(model.modelRef).not.toContain('secret-token');
      expect(model.modelRef).not.toContain('\n');
    }
    // No row is silently dropped: totals and the model list both retain every request and token.
    const summedRequests = usage.models.reduce((total, model) => total + model.requests, 0);
    const summedInput = usage.models.reduce((total, model) => total + (model.inputTokens ?? 0), 0);
    expect(summedRequests).toBe(usage.totals.requests);
    expect(summedInput).toBe(usage.totals.inputTokens);
    expect(usage.totals).toMatchObject({ requests: 2, inputTokens: 9, outputTokens: 3 });
    expect(usage.coverage.missing).toBe(true);
  });

  it('keeps an unknown-provider legacy id under an explicit unknown namespace', async () => {
    const services = await startServices();
    const session = makeSession('session_unknown_provider');
    services.sessions.put(session);
    seedUsageRow(services, {
      sessionId: session.id,
      modelRef: 'gpt-5',
      providerId: null,
      inputTokens: 3,
      outputTokens: 2,
    });
    const usage = sessionModelUsage(services, session.id);
    expect(usage.models).toHaveLength(1);
    expect(usage.models[0]).toMatchObject({ modelRef: 'unknown/gpt-5', providerId: null });
  });

  it('preserves missing dimensions as null while a reported zero stays zero', async () => {
    const services = await startServices();
    const missing = makeSession('session_missing');
    const zero = makeSession('session_zero');
    services.sessions.put(missing);
    services.sessions.put(zero);
    const requests = new RequestRepository(services.db.client);
    requests.put({
      id: 'req_missing',
      ts: '2026-01-01T00:00:00.000Z',
      provider: 'openai',
      model: 'gpt-5',
      session_id: missing.id,
      input_tokens: null,
      output_tokens: null,
      status: 'ok',
    });
    requests.put({
      id: 'req_zero',
      ts: '2026-01-01T00:00:00.000Z',
      provider: 'openai',
      model: 'gpt-5',
      session_id: zero.id,
      input_tokens: 0,
      output_tokens: 0,
      status: 'ok',
    });
    const missingUsage = sessionModelUsage(services, missing.id);
    expect(missingUsage.models[0]).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      cachedTokens: null,
      reasoningTokens: null,
      unreportedRequests: 1,
    });
    expect(missingUsage.totals.inputTokens).toBeNull();
    expect(missingUsage.incomplete).toBe(true);
    expect(missingUsage.coverage.missing).toBe(true);

    const zeroUsage = sessionModelUsage(services, zero.id);
    expect(zeroUsage.totals.inputTokens).toBe(0);
    expect(zeroUsage.totals.outputTokens).toBe(0);
    expect(zeroUsage.incomplete).toBe(false);
    expect(zeroUsage.coverage.missing).toBe(false);
  });

  it('drops malformed account keys and keeps only valid opaque ones', async () => {
    const services = await startServices();
    const session = makeSession('session_accounts');
    services.sessions.put(session);
    seedUsageRow(services, {
      sessionId: session.id,
      modelRef: 'openai/gpt-5',
      providerId: 'openai',
      accountKey: VALID_ACCOUNT_KEY,
    });
    seedUsageRow(services, {
      sessionId: session.id,
      modelRef: 'openai/gpt-6',
      providerId: 'openai',
      accountKey: 'owner@example.com',
    });
    const usage = sessionModelUsage(services, session.id);
    const valid = usage.models.find((model) => model.modelRef === 'openai/gpt-5');
    const invalid = usage.models.find((model) => model.modelRef === 'openai/gpt-6');
    expect(valid?.accountKey).toBe(VALID_ACCOUNT_KEY);
    expect(invalid?.accountKey).toBeNull();
  });

  it('reports the real retained coverage start and labels backfilled history as missing', async () => {
    const services = await startServices();
    const session = makeSession('session_backfill');
    services.sessions.put(session);
    seedRequest(services, {
      id: 'req_backfill',
      ts: '2026-01-02T00:00:00.000Z',
      provider: 'openai',
      model: 'gpt-5',
      sessionId: session.id,
      inputTokens: 7,
      outputTokens: 3,
    });
    expect(backfillSessionModelUsage(services.db.client)).toBe(1);
    const usage = sessionModelUsage(services, session.id);
    // The start is the real earliest retained ledger timestamp; backfill origin marks it incomplete.
    expect(usage.coverage).toEqual({ since: '2026-01-02T00:00:00.000Z', missing: true });
    expect(usage.totals).toMatchObject({ requests: 1, inputTokens: 7, outputTokens: 3 });
    expect(usage.incomplete).toBe(false);
  });

  it('marks coverage missing when a model could not be attributed to any provenance', async () => {
    const services = await startServices();
    const session = makeSession('session_unknown_provenance');
    services.sessions.put(session);
    seedUsageRow(services, {
      sessionId: session.id,
      modelRef: 'mystery-model',
      providerId: null,
      connectionId: null,
      inputTokens: 5,
      outputTokens: 2,
    });
    const usage = sessionModelUsage(services, session.id);
    expect(usage.models[0]?.modelRef.startsWith('unknown/')).toBe(true);
    expect(usage.coverage.missing).toBe(true);
    expect(usage.incomplete).toBe(false);
  });

  it('isolates one session from another conversation usage', async () => {
    const services = await startServices();
    const first = makeSession('session_first');
    const second = makeSession('session_second');
    services.sessions.put(first);
    services.sessions.put(second);
    const requests = new RequestRepository(services.db.client);
    requests.put({
      id: 'req_first',
      ts: '2026-01-01T00:00:00.000Z',
      provider: 'openai',
      model: 'gpt-5',
      session_id: first.id,
      input_tokens: 10,
      output_tokens: 4,
      status: 'ok',
    });
    requests.put({
      id: 'req_second',
      ts: '2026-01-01T00:00:00.000Z',
      provider: 'openai',
      model: 'gpt-5',
      session_id: second.id,
      input_tokens: 99,
      output_tokens: 99,
      status: 'ok',
    });
    expect(sessionModelUsage(services, first.id).totals).toMatchObject({
      requests: 1,
      inputTokens: 10,
      outputTokens: 4,
    });
  });
});

describe('lastRespondingModel', () => {
  const sessionId = SessionIdSchema.parse('session_replies');

  it('returns the model of the latest assistant reply across mixed models', () => {
    const messages = [
      message(sessionId, 'user', [textPart('first')], null, '2026-01-01T00:00:00.000Z'),
      message(sessionId, 'assistant', [textPart('one')], MODEL_A, '2026-01-01T00:00:01.000Z'),
      message(sessionId, 'user', [textPart('second')], null, '2026-01-01T00:00:02.000Z'),
      message(sessionId, 'assistant', [textPart('two')], MODEL_B, '2026-01-01T00:00:03.000Z'),
    ];
    expect(lastRespondingModel(messages)).toBe(MODEL_B);
  });

  it('does not let user, error-only or empty placeholder messages replace the reply', () => {
    const messages = [
      message(sessionId, 'assistant', [textPart('one')], MODEL_A, '2026-01-01T00:00:01.000Z'),
      message(sessionId, 'assistant', [errorPart('boom')], MODEL_B, '2026-01-01T00:00:02.000Z'),
      message(sessionId, 'assistant', [], MODEL_B, '2026-01-01T00:00:03.000Z'),
      message(sessionId, 'user', [textPart('again')], null, '2026-01-01T00:00:04.000Z'),
    ];
    expect(lastRespondingModel(messages)).toBe(MODEL_A);
  });

  it('falls back to a reply part producedBy when the message modelRef is absent', () => {
    const messages = [message(sessionId, 'assistant', [reasoningPart('thinking', PRODUCED)], null)];
    expect(lastRespondingModel(messages)).toBe(PRODUCED);
  });

  it('prefers the actual fallback producer over the message initial/logical model', () => {
    // The message records the initially selected model, but the reply part reports the actual
    // fallback producer that generated the content.
    const messages = [
      message(
        sessionId,
        'assistant',
        [textPart('answer'), reasoningPart('thinking', MODEL_B)],
        MODEL_A,
      ),
    ];
    expect(lastRespondingModel(messages)).toBe(MODEL_B);
  });

  it('uses the latest eligible producing part when parts disagree', () => {
    const messages = [
      message(
        sessionId,
        'assistant',
        [reasoningPart('planned', MODEL_A), toolCallPart('executed', MODEL_B)],
        MODEL_A,
      ),
    ];
    expect(lastRespondingModel(messages)).toBe(MODEL_B);
  });

  it('still counts a tool call that produced output as a reply', () => {
    const messages = [
      message(sessionId, 'assistant', [textPart('one')], MODEL_A, '2026-01-01T00:00:01.000Z'),
      message(
        sessionId,
        'assistant',
        [toolCallPart('wrote a file', MODEL_B)],
        null,
        '2026-01-01T00:00:02.000Z',
      ),
    ];
    expect(lastRespondingModel(messages)).toBe(MODEL_B);
  });

  it('uses the latest eligible part, including text, instead of borrowing an older producer', () => {
    // A fallback producer wrote the trailing text; the older reasoning/tool producers must not win.
    const messages = [
      message(
        sessionId,
        'assistant',
        [
          reasoningPart('planned', MODEL_A),
          toolCallPart('executed', MODEL_B),
          producedTextPart('final answer', PRODUCED),
        ],
        MODEL_A,
      ),
    ];
    expect(lastRespondingModel(messages)).toBe(PRODUCED);
  });

  it('is honest when the latest part has no producer and does not borrow an older attribution', () => {
    // The trailing text is unattributed, so the older reasoning producer must not be claimed.
    const messages = [
      message(
        sessionId,
        'assistant',
        [reasoningPart('thinking', MODEL_A), textPart('answer')],
        MODEL_B,
      ),
    ];
    expect(lastRespondingModel(messages)).toBe(MODEL_B);
  });

  it('does not claim a logical Gateway key as the responder', () => {
    const logical = ModelRefSchema.parse('gateway/requested-key');
    const messages = [message(sessionId, 'assistant', [textPart('routed reply')], logical)];
    expect(lastRespondingModel(messages)).toBeNull();
  });

  it('is honest about an unknown model instead of reusing an earlier reply', () => {
    const messages = [
      message(sessionId, 'assistant', [textPart('one')], MODEL_A, '2026-01-01T00:00:01.000Z'),
      message(sessionId, 'assistant', [textPart('two')], null, '2026-01-01T00:00:02.000Z'),
    ];
    expect(lastRespondingModel(messages)).toBeNull();
  });

  it('returns null for partial history with no assistant reply', () => {
    expect(lastRespondingModel([])).toBeNull();
    expect(lastRespondingModel([message(sessionId, 'user', [textPart('hi')], null)])).toBeNull();
  });
});

describe('sessionSummaryWithLastReply', () => {
  const sessionId = SessionIdSchema.parse('session_summary');

  it('sets lastReplyModelRef without touching id, title, project or profile', () => {
    const session = makeSession('session_summary', {
      title: 'Keep my title',
      workspaceId: null,
      profileId: ProfileIdSchema.parse('profile_builtin_balanced'),
      pinnedModelRef: MODEL_B,
      modelRef: MODEL_B,
    });
    const summary = sessionSummaryWithLastReply(session, [
      message(sessionId, 'assistant', [textPart('answer')], MODEL_A),
    ]);
    expect(summary).toMatchObject({
      id: session.id,
      title: 'Keep my title',
      profileId: session.profileId,
      workspaceId: null,
      pinnedModelRef: MODEL_B,
      modelRef: MODEL_B,
    });
    expect(summary.lastReplyModelRef).toBe(MODEL_A);
  });

  it('prefers the actual reply model over the pinned or predicted model', () => {
    const session = makeSession('session_summary', { pinnedModelRef: MODEL_B, modelRef: MODEL_B });
    const summary = sessionSummaryWithLastReply(session, [
      message(sessionId, 'assistant', [textPart('answer')], MODEL_A),
    ]);
    expect(summary.lastReplyModelRef).toBe(MODEL_A);
  });

  it('records the actual fallback producer instead of the message logical model', () => {
    const session = makeSession('session_summary', { pinnedModelRef: MODEL_A, modelRef: MODEL_A });
    const summary = sessionSummaryWithLastReply(session, [
      message(
        sessionId,
        'assistant',
        [textPart('answer'), reasoningPart('thinking', MODEL_B)],
        MODEL_A,
      ),
    ]);
    expect(summary.lastReplyModelRef).toBe(MODEL_B);
  });

  it('records the actual producer of the latest text part across mixed producer parts', () => {
    const session = makeSession('session_summary', { pinnedModelRef: MODEL_A, modelRef: MODEL_A });
    const summary = sessionSummaryWithLastReply(session, [
      message(
        sessionId,
        'assistant',
        [
          reasoningPart('planned', MODEL_A),
          toolCallPart('executed', MODEL_B),
          producedTextPart('final answer', PRODUCED),
        ],
        MODEL_A,
      ),
    ]);
    expect(summary.lastReplyModelRef).toBe(PRODUCED);
  });

  it('does not claim a logical Gateway key while the trailing reply is finalized', () => {
    const logical = ModelRefSchema.parse('gateway/requested-key');
    const session = makeSession('session_summary', { lastReplyModelRef: MODEL_A });
    const summary = sessionSummaryWithLastReply(session, [
      message(sessionId, 'assistant', [textPart('routed reply')], logical),
    ]);
    expect(summary.lastReplyModelRef).toBeNull();
  });

  it('preserves the existing value while the trailing reply may still be streaming', () => {
    const session = makeSession('session_summary', {
      status: 'running',
      inFlight: true,
      lastReplyModelRef: MODEL_A,
    });
    const summary = sessionSummaryWithLastReply(session, [
      message(sessionId, 'assistant', [textPart('done')], MODEL_A, '2026-01-01T00:00:01.000Z'),
      message(sessionId, 'assistant', [textPart('streaming')], MODEL_B, '2026-01-01T00:00:02.000Z'),
    ]);
    expect(summary.lastReplyModelRef).toBe(MODEL_A);
  });

  it('updates from a finalized reply while running when the trailing message is not a reply', () => {
    const session = makeSession('session_summary', {
      status: 'running',
      inFlight: true,
      lastReplyModelRef: null,
    });
    const summary = sessionSummaryWithLastReply(session, [
      message(sessionId, 'assistant', [textPart('done')], MODEL_A, '2026-01-01T00:00:01.000Z'),
      message(sessionId, 'user', [textPart('next')], null, '2026-01-01T00:00:02.000Z'),
    ]);
    expect(summary.lastReplyModelRef).toBe(MODEL_A);
  });

  it('keeps a summary without any reply unchanged', () => {
    const session = makeSession('session_summary', { lastReplyModelRef: MODEL_B });
    const summary = sessionSummaryWithLastReply(session, [
      message(sessionId, 'user', [textPart('hi')], null),
    ]);
    expect(summary.lastReplyModelRef).toBe(MODEL_B);
  });

  it('applies per-session messages in the batch helper', () => {
    const first = makeSession('session_batch_one');
    const second = makeSession('session_batch_two', { lastReplyModelRef: MODEL_B });
    const summaries = sessionSummariesWithLastReply(
      [first, second],
      new Map<string, readonly Message[]>([
        [first.id, [message(first.id, 'assistant', [textPart('one')], MODEL_A)]],
      ]),
    );
    expect(summaries[0]?.lastReplyModelRef).toBe(MODEL_A);
    expect(summaries[1]?.lastReplyModelRef).toBe(MODEL_B);
  });
});

describe('pendingApprovalSummary', () => {
  it('returns one actionable entry per pending approval across sessions', async () => {
    const services = await startServices();
    const first = makeSession('session_pending_one', { status: 'awaiting_approval' });
    const second = makeSession('session_pending_two', {
      status: 'awaiting_approval',
      title: 'Second task',
    });
    services.sessions.put(first);
    services.sessions.put(second);
    const firstPart = approvalPart('pending');
    const secondPart = approvalPart('pending');
    services.messages.put(message(first.id, 'assistant', [firstPart], MODEL_A));
    services.messages.put(message(second.id, 'assistant', [secondPart], MODEL_B));

    const summary = pendingApprovalSummary(services);
    expect(summary.entries).toHaveLength(2);
    expect(summary.entries).toContainEqual({
      sessionId: first.id,
      title: first.title,
      partId: firstPart.id,
      kind: 'command',
      summary: firstPart.summary,
      detail: firstPart.detail,
      risk: 'medium',
    });
    expect(summary.entries).toContainEqual(expect.objectContaining({ sessionId: second.id }));
  });

  it('excludes resolved, removed and non-awaiting sessions', async () => {
    const services = await startServices();
    const awaiting = makeSession('session_awaiting', { status: 'awaiting_approval' });
    const idle = makeSession('session_idle', { status: 'idle' });
    services.sessions.put(awaiting);
    services.sessions.put(idle);
    services.messages.put(
      message(
        awaiting.id,
        'assistant',
        [approvalPart('allowed_once'), approvalPart('denied'), approvalPart('pending')],
        MODEL_A,
      ),
    );
    services.messages.put(message(idle.id, 'assistant', [approvalPart('pending')], MODEL_A));
    // A removed session can leave a lingering message; it must never resurface.
    services.messages.put(
      message(
        SessionIdSchema.parse('session_removed'),
        'assistant',
        [approvalPart('pending')],
        MODEL_A,
      ),
    );

    const summary = pendingApprovalSummary(services);
    expect(summary.entries).toHaveLength(1);
    expect(summary.entries[0]).toMatchObject({ sessionId: awaiting.id, kind: 'command' });
  });

  it('returns exactly the documented actionable fields without credentials', async () => {
    const services = await startServices();
    const session = makeSession('session_fields', { status: 'awaiting_approval' });
    services.sessions.put(session);
    services.messages.put(message(session.id, 'assistant', [approvalPart('pending')], MODEL_A));
    const summary = pendingApprovalSummary(services);
    expect(summary.entries).toHaveLength(1);
    expect(Object.keys(summary.entries[0] ?? {}).sort()).toEqual([
      'detail',
      'kind',
      'partId',
      'risk',
      'sessionId',
      'summary',
      'title',
    ]);
  });

  it('stays bounded on a large idle list without per-session detail fan-out', async () => {
    const services = await startServices();
    const activeOne = makeSession('session_active_one', { status: 'awaiting_approval' });
    const activeTwo = makeSession('session_active_two', { status: 'awaiting_approval' });
    for (const session of [activeOne, activeTwo]) services.sessions.put(session);
    services.messages.put(message(activeOne.id, 'assistant', [approvalPart('pending')], MODEL_A));
    services.messages.put(message(activeTwo.id, 'assistant', [approvalPart('pending')], MODEL_A));

    const bulk = services.db.client.transaction(() => {
      const insertSession = services.db.client.prepare(
        'INSERT INTO sessions (id,data_json,updated_at) VALUES (?,?,?)',
      );
      const insertMessage = services.db.client.prepare(
        'INSERT INTO messages (id,data_json,updated_at) VALUES (?,?,?)',
      );
      for (let index = 0; index < 500; index += 1) {
        const session = makeSession(`session_idle_${String(index)}`);
        insertSession.run(session.id, JSON.stringify(session), session.updatedAt);
        const idleMessage = message(
          session.id,
          'assistant',
          [textPart(`idle transcript ${String(index)}`)],
          MODEL_A,
        );
        insertMessage.run(idleMessage.id, JSON.stringify(idleMessage), idleMessage.createdAt);
      }
    });
    bulk();

    const getSpy = vi.spyOn(services.sessions, 'get');
    const listSpy = vi.spyOn(services.messages, 'list');
    const summary = pendingApprovalSummary(services);
    expect(summary.entries).toHaveLength(2);
    expect(getSpy).not.toHaveBeenCalled();
    expect(listSpy).not.toHaveBeenCalled();
    getSpy.mockRestore();
    listSpy.mockRestore();
  });

  it('handles more awaiting sessions than the SQLite variable limit without overflowing', async () => {
    const services = await startServices();
    const insertSession = services.db.client.prepare(
      'INSERT INTO sessions (id,data_json,updated_at) VALUES (?,?,?)',
    );
    const insertMessage = services.db.client.prepare(
      'INSERT INTO messages (id,data_json,updated_at) VALUES (?,?,?)',
    );
    const seed = services.db.client.transaction(() => {
      for (let index = 0; index < 1100; index += 1) {
        const session = makeSession(`session_bulk_${String(index)}`, {
          status: 'awaiting_approval',
        });
        insertSession.run(session.id, JSON.stringify(session), session.updatedAt);
        const pending = message(session.id, 'assistant', [approvalPart('pending')], MODEL_A);
        insertMessage.run(pending.id, JSON.stringify(pending), pending.createdAt);
      }
    });
    seed();
    const summary = pendingApprovalSummary(services);
    expect(summary.entries).toHaveLength(1100);
    expect(new Set(summary.entries.map((entry) => entry.sessionId)).size).toBe(1100);
  });

  it('skips corrupt legacy message rows instead of failing the whole summary', async () => {
    const services = await startServices();
    const session = makeSession('session_corrupt', { status: 'awaiting_approval' });
    services.sessions.put(session);
    services.messages.put(message(session.id, 'assistant', [approvalPart('pending')], MODEL_A));
    const insertRaw = services.db.client.prepare(
      'INSERT INTO messages (id,data_json,updated_at) VALUES (?,?,?)',
    );
    insertRaw.run('message_corrupt_one', '{not valid json', '2026-01-01T00:00:00.000Z');
    insertRaw.run('message_corrupt_two', 'null', '2026-01-01T00:00:00.000Z');
    const summary = pendingApprovalSummary(services);
    expect(summary.entries).toHaveLength(1);
    expect(summary.entries[0]).toMatchObject({ sessionId: session.id });
  });

  it('surfaces an infrastructure failure as a redacted error instead of empty approvals', async () => {
    const services = await startServices();
    const session = makeSession('session_broken_store', { status: 'awaiting_approval' });
    services.sessions.put(session);
    services.db.client.exec('DROP TABLE messages');
    let thrown: unknown;
    try {
      pendingApprovalSummary(services);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ kind: 'unavailable' });
    expect(thrown).toBeInstanceOf(Error);
  });
});
