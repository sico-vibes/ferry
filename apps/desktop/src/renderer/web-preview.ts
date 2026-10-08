import type { MockFerryClient } from '@ferry/client';
import { FailureEntrySchema, PausedReasonSchema } from '@ferry/shared';
import type { Message, MessagePart, ProviderKey } from '@ferry/shared';

const stamp = '2026-10-04T10:00:00.000Z';

export async function seedWebPreview(client: MockFerryClient, scenario: string): Promise<void> {
  const store = client.__store();
  const chosen = ['empty', 'errors', 'busy', 'failures'].includes(scenario) ? scenario : 'busy';
  const params = new URLSearchParams(location.search);
  const theme = params.get('theme');
  if (theme === 'light' || theme === 'dark' || theme === 'system') store.settings.theme = theme;

  if (chosen === 'empty') {
    store.sessions.splice(0);
    store.messages.clear();
    store.providers.splice(0);
    store.requestFailures.splice(0);
    store.providerKeys.clear();
    store.settings.onboardingComplete = false;
    await client.gateway.setSettings({ enabled: false, port: 11435, allowLan: false });
    return;
  }

  store.settings.onboardingComplete = true;
  for (const provider of store.providers) {
    if (provider.id === 'openai') {
      provider.keyStatus = 'valid';
      provider.enabled = true;
    }
    if (provider.id === 'anthropic') provider.keyStatus = 'invalid';
    if (provider.id === 'groq') provider.enabled = false;
    if (provider.id === 'opencode-go') provider.keyStatus = 'valid';
    if (provider.id === 'huggingface') provider.tag = 'trial';
  }
  if (chosen === 'failures') {
    const groq = store.providers.find((provider) => provider.id === 'groq');
    const now = new Date();
    store.requestFailures.splice(
      0,
      store.requestFailures.length,
      ...Array.from({ length: 6 }, (_, index) =>
        FailureEntrySchema.parse({
          id: `preview-failure-${String(index)}`,
          at: new Date(now.getTime() - (6 - index) * 60_000).toISOString(),
          providerId: 'groq',
          modelRef: index === 0 ? 'groq/qwen/qwen3.8-27b' : 'groq/openai/gpt-oss-120b',
          keyId: 'groq:1',
          requestId: `preview-request-${String(index)}`,
          sessionId: null,
          source: 'agent',
          kind: index === 0 ? 'rate_limit' : 'server',
          statusCode: index === 0 ? 429 : 502,
          message:
            index === 0 ? 'Rate limit reached; retry after reset.' : '502 Upstream service error.',
          counted: index === 0 ? 0 : 1,
        }),
      ),
    );
    if (groq)
      groq.pausedReason = PausedReasonSchema.parse({
        kind: 'failed_requests',
        at: now.toISOString(),
        failedRequests: 5,
        lastError: '502 Upstream service error.',
        lastKind: 'server',
        models: ['groq/openai/gpt-oss-120b'],
      });
  }
  const keys: ProviderKey[] = [
    {
      id: 'preview-openai-main',
      providerId: 'openai' as ProviderKey['providerId'],
      label: 'Primary workspace',
      order: 0,
      enabled: true,
      status: 'ok',
      lastFour: '4d21',
      usageToday: { requests: 34, tokens: 28600 },
      lastError: null,
      cooldownUntil: null,
    },
    {
      id: 'preview-openai-backup',
      providerId: 'openai' as ProviderKey['providerId'],
      label: 'Backup key',
      order: 1,
      enabled: true,
      status: 'ok',
      lastFour: 'b738',
      usageToday: { requests: 9, tokens: 7200 },
      lastError: null,
      cooldownUntil: null,
    },
    {
      id: 'preview-anthropic',
      providerId: 'anthropic' as ProviderKey['providerId'],
      label: 'Team key',
      order: 0,
      enabled: true,
      status: 'invalid',
      lastFour: '91af',
      usageToday: { requests: 0, tokens: 0 },
      lastError: 'The key was rejected by the provider.',
      cooldownUntil: null,
    },
  ];
  store.providerKeys.set('openai', keys.slice(0, 2));
  store.providerKeys.set('anthropic', keys.slice(2));
  await client.gateway.setSettings({ enabled: true, port: 11435, allowLan: false });
  for (const name of ['Local development', 'CI smoke tests', 'Jordan'])
    await client.gateway.createKey({ name, profile: 'Auto-Free' });

  const sessions = store.sessions;
  for (const session of sessions.slice(0, 8)) {
    const existing = store.messages.get(session.id) ?? [];
    const text = (id: string, role: 'user' | 'assistant', content: string): Message => ({
      id: id as Message['id'],
      sessionId: session.id,
      role,
      createdAt: stamp,
      modelRef: role === 'assistant' ? ('cerebras/gpt-oss-120b' as Message['modelRef']) : null,
      parts: [{ type: 'text', id: `${id}-part` as MessagePart['id'], text: content }],
    });
    const part = (id: string, value: Record<string, unknown>): MessagePart =>
      ({ ...value, id: id as MessagePart['id'] }) as MessagePart;
    const timeline: Message = {
      id: `preview-${session.id}-timeline` as Message['id'],
      sessionId: session.id,
      role: 'assistant',
      createdAt: stamp,
      modelRef: 'cerebras/gpt-oss-120b' as Message['modelRef'],
      parts: [
        part(`thinking-${session.id}`, {
          type: 'reasoning',
          text: 'I will trace the current behavior, check the nearby tests, then make the smallest safe change.',
        }),
        part(`tool-${session.id}`, {
          type: 'tool_call',
          tool: 'run_command',
          title: 'Inspect project checks',
          args: { command: 'pnpm test -- --runInBand' },
          status: 'succeeded',
          output: {
            text: '214 tests passed in 3.8s',
            filtered: false,
            originalTokens: null,
            filteredTokens: null,
            recoveryHandle: null,
          },
          changes: [],
          durationMs: 3840,
        }),
        part(`approval-${session.id}`, {
          type: 'approval_request',
          kind: 'command',
          summary: 'Run the focused test suite',
          detail: 'pnpm test -- --runInBand',
          risk: 'low',
          state: session === sessions[0] ? 'pending' : 'allowed_once',
        }),
        part(`handoff-${session.id}`, {
          type: 'handoff_marker',
          from: 'cerebras/gpt-oss-120b',
          to: 'nvidia/nemotron-3-ultra',
          reason: 'quota',
          briefingTokens: 1820,
          explanation: 'Continue review on a second available provider.',
        }),
        part(`error-${session.id}`, {
          type: 'error',
          message: 'One provider timed out; the request was retried on the backup route.',
          kind: 'provider',
          details: { attempts: [] },
        }),
        part(`code-${session.id}`, {
          type: 'text',
          text: 'The retry path now preserves the original request context.\n\n```ts\nconst result = await router.complete(input, { signal });\nreturn validate(result);\n```',
        }),
      ],
    };
    store.messages.set(session.id, [
      ...existing,
      text(
        `preview-${session.id}-user`,
        'user',
        `Can you review ${session.title.toLowerCase()} and explain the tradeoffs?`,
      ),
      timeline,
    ]);
    session.status = session === sessions[0] ? 'awaiting_approval' : 'idle';
  }
  // Keep the showcase transcript long enough to exercise the renderer's actual scroll area.
  const showcase = sessions[2];
  if (showcase) {
    const messages = store.messages.get(showcase.id) ?? [];
    for (let index = 0; index < 8; index++)
      messages.push({
        id: `preview-long-${String(index)}` as Message['id'],
        sessionId: showcase.id,
        role: index % 2 ? 'assistant' : 'user',
        createdAt: stamp,
        modelRef: null,
        parts: [
          {
            type: 'text',
            id: `preview-long-part-${String(index)}` as MessagePart['id'],
            text:
              index % 2
                ? [
                    'The investigation is on track. Checkpoint ' +
                      String(index + 1) +
                      ' is verified against the project constraints.',
                    '',
                    '- preserve the existing API',
                    '- keep retries bounded',
                    '- report any provider limitation',
                    '',
                    '```ts',
                    'const retry = Math.min(attempt * 250, 2000);',
                    '```',
                  ].join('\n')
                : 'Please keep the patch narrow and include the related test output.',
          },
        ],
      });
  }

  if (chosen === 'errors') {
    for (const provider of store.providers) {
      provider.health = 'cooldown';
      provider.enabled = true;
    }
    for (const session of sessions.slice(0, 3)) session.status = 'interrupted';
    const failedSession = sessions[0];
    if (failedSession)
      store.delegationRuns.push({
        id: 'preview-failed-run' as (typeof store.delegationRuns)[number]['id'],
        sessionId: failedSession.id,
        lane: 'qa',
        implementer: 'opencode',
        brief: 'Run integration review',
        status: 'failed',
        startedAt: stamp,
        finishedAt: stamp,
        progress: [{ at: stamp, text: 'Provider credentials unavailable' }],
        events: [],
        finalMessage: 'The delegated run could not start because its provider is offline.',
        touchedFiles: [],
        gateResults: [],
        usage: null,
        decision: null,
      });
    localStorage.setItem('ferry.simulateOffline', 'true');
  } else {
    localStorage.removeItem('ferry.simulateOffline');
  }
  // A fake live request stream for the Gateway dashboard; no network access.
  const gatewayKeys = (await client.gateway.listKeys()).filter((key) => !key.revokedAt);
  const routes = [
    ['ferry/auto-free', 'cerebras/gpt-oss-120b'],
    ['ferry/auto-free', 'gemini/gemini-3.8-flash'],
    ['ferry/fast', 'groq/openai/gpt-oss-120b'],
    ['ferry/best', 'nvidia/nemotron-3-ultra'],
    ['mistral/codestral-latest', 'mistral/codestral-latest'],
  ] as const;
  let sequence = 0;
  const pushRequest = (at: Date) => {
    sequence += 1;
    const key = gatewayKeys[sequence % gatewayKeys.length];
    const route = routes[sequence % routes.length];
    if (!key || !route) return;
    const failed = chosen === 'errors' ? sequence % 3 === 0 : sequence % 11 === 0;
    client.__gatewayRequest({
      id: `preview-request-${String(sequence)}`,
      at: at.toISOString(),
      keyId: key.id,
      keyName: key.name,
      requestedModel: route[0],
      modelRef: failed ? null : route[1],
      providerId: failed ? null : route[1].slice(0, route[1].indexOf('/')),
      status: failed ? 'error' : 'ok',
      inputTokens: failed ? 0 : 1_200 + ((sequence * 977) % 9_000),
      outputTokens: failed ? 0 : 180 + ((sequence * 331) % 1_400),
      latencyMs: 380 + ((sequence * 613) % 4_200),
      error: failed ? 'All eligible providers are cooling down; retry after 30s.' : null,
    });
  };
  for (let index = 18; index > 0; index--) pushRequest(new Date(Date.now() - index * 47_000));
  window.setInterval(() => {
    pushRequest(new Date());
  }, 4_000);
}
