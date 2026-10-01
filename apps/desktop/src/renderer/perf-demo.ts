import type { Message, ModelInfo, SessionId } from '@ferry/shared';
import type { MockFerryClient } from '@ferry/client';

export function seedLongTranscript(client: MockFerryClient): SessionId | undefined {
  const session = client.__state().sessions[0];
  if (!session) return undefined;

  const now = new Date().toISOString();
  const messages: Message[] = Array.from({ length: 10_000 }, (_, index) => {
    const messageId = `perf-message-${String(index)}` as Message['id'];
    const partId = `perf-tool-${String(index)}` as Message['parts'][number]['id'];
    const textId = `perf-text-${String(index)}` as Message['parts'][number]['id'];
    return {
      id: messageId,
      sessionId: session.id,
      role: 'assistant',
      createdAt: now,
      modelRef: session.modelRef,
      parts: [
        {
          id: partId,
          type: 'tool_call',
          tool: 'read_file',
          title: `Read file ${String(index + 1)}`,
          args: { path: `src/module-${String(index + 1)}.ts` },
          status: 'succeeded',
          output: {
            text: 'Read 24 lines.',
            filtered: false,
            originalTokens: null,
            filteredTokens: null,
            recoveryHandle: null,
          },
          changes: [],
          durationMs: 12,
        },
        {
          id: textId,
          type: 'text',
          text: `Inspection update ${String(index + 1)}: reviewed the module and recorded its role in the application.`,
        },
      ],
    };
  });

  client.__state().messages.set(session.id, messages);
  window.ferryPerfMessageCount = messages.length;
  const location = new URL(window.location.href);
  location.pathname = `/s/${session.id}`;
  location.searchParams.set('demo', 'long');
  history.replaceState(null, '', location);
  return session.id;
}

export function seedExploreModels(client: MockFerryClient): void {
  const state = client.__state();
  const template = state.models[0];
  if (!template) return;
  const models: ModelInfo[] = Array.from({ length: 1_200 }, (_, index) => ({
    ...structuredClone(template),
    ref: `${template.providerId}/perf-model-${String(index + 1).padStart(4, '0')}` as ModelInfo['ref'],
    name: `Performance model ${String(index + 1).padStart(4, '0')}`,
  }));
  state.models.splice(0, state.models.length, ...models);
  const provider = state.providers.find((item) => item.id === template.providerId);
  if (provider) {
    provider.availableModels = structuredClone(models);
    provider.modelCount = models.length;
  }
  window.ferryPerfModelCount = models.length;
}

export function seedExhaustedSession(client: MockFerryClient): SessionId | undefined {
  const state = client.__state();
  const session =
    state.sessions.find((candidate) => (state.messages.get(candidate.id)?.length ?? 0) > 0) ??
    state.sessions[0];
  if (!session) return undefined;
  const now = new Date().toISOString();
  const errorModel =
    state.models[0]?.ref ?? ('openai/gpt-4o-mini' as NonNullable<Message['modelRef']>);
  const attempt = {
    model: errorModel,
    kind: 'rate_limit' as const,
    status: 429,
    message: 'Free capacity is exhausted until the next reset.',
    provider: 'groq',
    latencyMs: 84,
  };
  const message: Message = {
    id: `demo-error-${String(Date.now())}` as Message['id'],
    sessionId: session.id,
    role: 'assistant',
    createdAt: now,
    modelRef: session.modelRef,
    parts: [
      {
        id: `demo-error-part-${String(Date.now())}` as Message['parts'][number]['id'],
        type: 'error',
        message: 'All free candidates exhausted for plan. Next free capacity: Groq in 12 min.',
        details: { attempts: [attempt], nextCapacity: 'Groq in 12 min' },
        kind: 'all_candidates_exhausted',
      },
    ],
  };
  const sessionIndex = state.sessions.findIndex((candidate) => candidate.id === session.id);
  if (sessionIndex >= 0)
    state.sessions[sessionIndex] = { ...session, status: 'error', updatedAt: now };
  state.messages.set(session.id, [...(state.messages.get(session.id) ?? []), message]);
  const location = new URL(window.location.href);
  location.pathname = `/s/${session.id}`;
  location.searchParams.set('demo', 'exhausted');
  history.replaceState(null, '', location);
  return session.id;
}
