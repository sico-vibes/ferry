import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { MessagePart, SessionDetail } from '@ferry/shared';
import { keys } from './queries';
import { useFerryClient } from './client';
import { useToasts } from '../state/toasts';
import { useUI } from '../state/ui';

type SessionFileChange = Extract<MessagePart, { type: 'tool_call' }>['changes'][number];

function patchSessionChanges(
  cache: ReturnType<typeof useQueryClient>,
  sessionId: string,
  changes: readonly SessionFileChange[],
): void {
  if (!changes.length) return;
  cache.setQueryData<SessionFileChange[]>(['session-changes', sessionId], (current) => {
    if (!current) return current;
    const byPath = new Map(current.map((change) => [change.path, change]));
    for (const change of changes) byPath.set(change.path, change);
    return [...byPath.values()];
  });
}

export function useFerryEvents(): void {
  const client = useFerryClient();
  const cache = useQueryClient();
  const pushToast = useToasts((state) => state.push);
  useEffect(() => {
    const off = [
      client.on('quota.updated', (capacity) => cache.setQueryData(keys.capacity, capacity)),
      client.on('session.updated', (session) => {
        void cache.invalidateQueries({ queryKey: keys.sessions });
        const key = keys.session(session.id);
        const current = cache.getQueryData<SessionDetail>(key);
        if (current) cache.setQueryData(key, { ...current, session });
      }),
      client.on('session.message', ({ sessionId, message }) => {
        patchSessionChanges(
          cache,
          sessionId,
          message.parts.flatMap((part) => (part.type === 'tool_call' ? part.changes : [])),
        );
        const key = keys.session(sessionId);
        const current = cache.getQueryData<SessionDetail>(key);
        if (!current) {
          void cache.invalidateQueries({ queryKey: key });
          return;
        }
        if (current.messages.some((item) => item.id === message.id)) return;
        cache.setQueryData(key, { ...current, messages: [...current.messages, message] });
      }),
      client.on('session.part', ({ sessionId, messageId, part }) => {
        if (part.type === 'tool_call') patchSessionChanges(cache, sessionId, part.changes);
        const key = keys.session(sessionId);
        const current = cache.getQueryData<import('@ferry/shared').SessionDetail>(key);
        if (!current) {
          void cache.invalidateQueries({ queryKey: key });
        } else {
          const messageIndex = current.messages.findIndex((message) => message.id === messageId);
          const message = current.messages[messageIndex];
          if (messageIndex < 0 || !message) {
            void cache.invalidateQueries({ queryKey: key });
          } else {
            const existing = message.parts.find((item) => item.id === part.id);
            if (!existing || JSON.stringify(existing) !== JSON.stringify(part)) {
              const updatedMessage = existing
                ? {
                    ...message,
                    parts: message.parts.map((item) => (item.id === part.id ? part : item)),
                  }
                : { ...message, parts: [...message.parts, part] };
              const messages = current.messages.slice();
              messages[messageIndex] = updatedMessage;
              cache.setQueryData(key, { ...current, messages });
            }
          }
        }
        // Checkpoint rows are queried separately from the session transcript.
        // Refresh only that lightweight panel query; never refetch the 10k-message
        // session detail just because an agent made a checkpoint.
        if (part.type === 'checkpoint') {
          void cache.invalidateQueries({ queryKey: ['checkpoints', sessionId] });
        }
        if (
          part.type === 'approval_request' &&
          part.state === 'pending' &&
          useUI.getState().activeId !== sessionId
        ) {
          const session = cache.getQueryData<{ session: { title: string } }>(
            keys.session(sessionId),
          );
          pushToast({
            kind: 'warning',
            title: 'Approval needed',
            body: session?.session.title ?? part.summary,
          });
        }
      }),
      client.on('session.delta', ({ sessionId, messageId, partId, textDelta }) => {
        const key = keys.session(sessionId);
        const current = cache.getQueryData<import('@ferry/shared').SessionDetail>(key);
        if (!current) {
          void cache.invalidateQueries({ queryKey: key });
          return;
        }
        const messageIndex = current.messages.findIndex((message) => message.id === messageId);
        const message = current.messages[messageIndex];
        if (messageIndex < 0 || !message) {
          void cache.invalidateQueries({ queryKey: key });
          return;
        }
        const exists = message.parts.some((part) => part.id === partId);
        const updatedMessage = {
          ...message,
          parts: exists
            ? message.parts.map((part) =>
                part.id === partId && part.type === 'text'
                  ? { ...part, text: part.text + textDelta }
                  : part,
              )
            : [...message.parts, { type: 'text' as const, id: partId, text: textDelta }],
        };
        const messages = current.messages.slice();
        messages[messageIndex] = updatedMessage;
        cache.setQueryData(key, { ...current, messages });
      }),
      client.on('task.updated', (task) => {
        const key = keys.session(task.sessionId);
        const current = cache.getQueryData<SessionDetail>(key);
        if (current) cache.setQueryData(key, { ...current, taskRecord: task });
        else void cache.invalidateQueries({ queryKey: key });
      }),
      client.on('provider.updated', (provider) => {
        void cache.invalidateQueries({ queryKey: ['providers'] });
        void cache.invalidateQueries({ queryKey: ['models'] });
        void cache.invalidateQueries({ queryKey: ['model-candidates'] });
        pushToast({ kind: 'info', title: `${provider.name} updated`, body: null });
      }),
      client.on('delegation.updated', (run) => {
        void cache.invalidateQueries({ queryKey: ['delegation', run.sessionId] });
        if (run.status === 'completed') {
          window.dispatchEvent(
            new CustomEvent('ferry:success-pulse', { detail: { sessionId: run.sessionId } }),
          );
        }
        pushToast(
          { kind: 'info', title: `Delegation ${run.status}`, body: run.lane },
          `delegation:${run.id}`,
        );
      }),
      client.on('toast', pushToast),
    ];
    return () => {
      off.forEach((unsubscribe) => {
        unsubscribe();
      });
    };
  }, [cache, client, pushToast]);
}
