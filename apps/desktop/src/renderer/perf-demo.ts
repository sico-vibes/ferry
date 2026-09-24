import type { Message, SessionId } from '@ferry/shared';
import type { MockFerryClient } from '@ferry/client';

export function seedLongTranscript(client: MockFerryClient): SessionId | undefined {
  const session = client.__state().sessions[0];
  if (!session) return undefined;

  const now = new Date().toISOString();
  const messages: Message[] = Array.from({ length: 1_000 }, (_, index) => {
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
  const location = new URL(window.location.href);
  location.pathname = `/s/${session.id}`;
  location.searchParams.set('demo', 'long');
  history.replaceState(null, '', location);
  return session.id;
}
