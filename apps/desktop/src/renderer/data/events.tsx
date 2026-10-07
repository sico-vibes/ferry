import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type {
  MessageId,
  MessagePart,
  PartId,
  Session,
  SessionDetail,
  SessionId,
} from '@ferry/shared';
import { keys } from './queries';
import { chatNotificationFor } from './notifications';
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
  const flushPendingDeltas = useRef<() => void>(() => undefined);
  useEffect(() => {
    const lastStatus = new Map<string, Session['status']>();
    const pendingParts = new Map<string, Map<PartId, MessagePart>>();
    const pendingKey = (sessionId: SessionId, messageId: MessageId) => `${sessionId}:${messageId}`;
    const takePendingParts = (sessionId: SessionId, messageId: MessageId) => {
      const key = pendingKey(sessionId, messageId);
      const parts = pendingParts.get(key);
      pendingParts.delete(key);
      return parts ? [...parts.values()] : [];
    };
    const off = [
      client.on('quota.updated', (capacity) => cache.setQueryData(keys.capacity, capacity)),
      client.on('quota.limits.updated', (limits) => cache.setQueryData(keys.limits, limits)),
      client.on('session.updated', (session) => {
        const previous = lastStatus.get(session.id);
        lastStatus.set(session.id, session.status);
        const notification = chatNotificationFor(previous, session);
        if (notification) void window.ferryHost?.notify(notification).catch(() => undefined);
        // Patch the sidebar row in place (every sessions query, keyed by its search text);
        // refetch only when no list has this chat yet.
        const known = cache
          .getQueriesData<Session[]>({ queryKey: keys.sessions })
          .some(([, rows]) => rows?.some((row) => row.id === session.id));
        if (known)
          cache.setQueriesData<Session[]>({ queryKey: keys.sessions }, (current) =>
            current?.map((row) => (row.id === session.id ? session : row)),
          );
        else void cache.invalidateQueries({ queryKey: keys.sessions });
        const key = keys.session(session.id);
        const current = cache.getQueryData<SessionDetail>(key);
        if (current) cache.setQueryData(key, { ...current, session });
      }),
      client.on('session.removed', ({ id }) => {
        // Empty chats are cleaned up by the engine; drop them from the sidebar and open tabs.
        cache.removeQueries({ queryKey: keys.session(id) });
        void cache.invalidateQueries({ queryKey: keys.sessions });
        if (useUI.getState().tabs.some((tab) => tab.id === id)) useUI.getState().closeTab(id);
      }),
      client.on('agent.event', ({ sessionId, event }) => {
        const key = keys.session(sessionId);
        const current = cache.getQueryData<SessionDetail>(key);
        if (current) {
          if (!current.session.agentEvents.some((item) => item.id === event.id)) {
            cache.setQueryData(key, {
              ...current,
              session: {
                ...current.session,
                agentEvents: [...current.session.agentEvents, event].slice(-2_000),
              },
            });
          }
        } else void cache.invalidateQueries({ queryKey: key });
      }),
      client.on('session.message', ({ sessionId, message }) => {
        const key = keys.session(sessionId);
        const current = cache.getQueryData<SessionDetail>(key);
        if (!current) {
          takePendingParts(sessionId, message.id);
          void cache.invalidateQueries({ queryKey: key });
          return;
        }
        const parts = takePendingParts(sessionId, message.id);
        const messageWithPendingParts = parts.length
          ? {
              ...message,
              parts: [
                ...message.parts,
                ...parts.filter(
                  (part) => !message.parts.some((existing) => existing.id === part.id),
                ),
              ],
            }
          : message;
        patchSessionChanges(
          cache,
          sessionId,
          messageWithPendingParts.parts.flatMap((part) =>
            part.type === 'tool_call' ? part.changes : [],
          ),
        );
        const existingIndex = current.messages.findIndex((item) => item.id === message.id);
        if (existingIndex >= 0) {
          if (!parts.length) return;
          const existingMessage = current.messages[existingIndex];
          if (!existingMessage) return;
          const mergedMessage = {
            ...existingMessage,
            parts: [
              ...existingMessage.parts,
              ...parts.filter(
                (part) => !existingMessage.parts.some((existing) => existing.id === part.id),
              ),
            ],
          };
          const messages = current.messages.slice();
          messages[existingIndex] = mergedMessage;
          cache.setQueryData(key, { ...current, messages });
          return;
        }
        cache.setQueryData(key, {
          ...current,
          messages: [...current.messages, messageWithPendingParts],
        });
      }),
      client.on('session.part', ({ sessionId, messageId, part }) => {
        flushPendingDeltas.current();
        if (part.type === 'tool_call') patchSessionChanges(cache, sessionId, part.changes);
        const key = keys.session(sessionId);
        const current = cache.getQueryData<import('@ferry/shared').SessionDetail>(key);
        if (!current) {
          const eventKey = pendingKey(sessionId, messageId);
          const parts = pendingParts.get(eventKey) ?? new Map<PartId, MessagePart>();
          parts.set(part.id, part);
          pendingParts.set(eventKey, parts);
          void cache.invalidateQueries({ queryKey: key });
        } else {
          const messageIndex = current.messages.findIndex((message) => message.id === messageId);
          const message = current.messages[messageIndex];
          if (messageIndex < 0 || !message) {
            const eventKey = pendingKey(sessionId, messageId);
            const parts = pendingParts.get(eventKey) ?? new Map<PartId, MessagePart>();
            parts.set(part.id, part);
            pendingParts.set(eventKey, parts);
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
      (() => {
        const pending = new Map<
          string,
          { sessionId: SessionId; messageId: MessageId; partId: PartId; text: string }
        >();
        let frame = 0;
        const flush = () => {
          frame = 0;
          for (const { sessionId, messageId, partId, text } of pending.values()) {
            const key = keys.session(sessionId);
            const current = cache.getQueryData<SessionDetail>(key);
            if (!current) {
              void cache.invalidateQueries({ queryKey: key });
              continue;
            }
            const messageIndex = current.messages.findIndex((message) => message.id === messageId);
            const message = current.messages[messageIndex];
            if (messageIndex < 0 || !message) {
              void cache.invalidateQueries({ queryKey: key });
              continue;
            }
            const exists = message.parts.some((part) => part.id === partId);
            const updatedMessage = {
              ...message,
              parts: exists
                ? message.parts.map((part) =>
                    part.id === partId && part.type === 'text'
                      ? { ...part, text: part.text + text }
                      : part,
                  )
                : [...message.parts, { type: 'text' as const, id: partId, text }],
            };
            const messages = current.messages.slice();
            messages[messageIndex] = updatedMessage;
            cache.setQueryData(key, { ...current, messages });
          }
          pending.clear();
        };
        const off = client.on('session.delta', ({ sessionId, messageId, partId, textDelta }) => {
          const id = `${sessionId}:${messageId}:${partId}`;
          const previous = pending.get(id);
          pending.set(id, {
            sessionId,
            messageId,
            partId,
            text: `${previous?.text ?? ''}${textDelta}`,
          });
          if (!frame) frame = requestAnimationFrame(flush);
        });
        flushPendingDeltas.current = flush;
        return () => {
          off();
          if (frame) cancelAnimationFrame(frame);
          flush();
          flushPendingDeltas.current = () => undefined;
        };
      })(),
      client.on('task.updated', (task) => {
        const key = keys.session(task.sessionId);
        const current = cache.getQueryData<SessionDetail>(key);
        if (current) cache.setQueryData(key, { ...current, taskRecord: task });
        else void cache.invalidateQueries({ queryKey: key });
      }),
      client.on('provider.updated', () => {
        void cache.invalidateQueries({ queryKey: ['providers'] });
        void cache.invalidateQueries({ queryKey: ['models'] });
        void cache.invalidateQueries({ queryKey: ['model-candidates'] });
      }),
      client.on('settings.updated', (settings) => {
        cache.setQueryData(keys.settings, settings);
      }),
      client.on('delegation.updated', (run) => {
        const key = ['delegation', run.sessionId] as const;
        const current = cache.getQueryData<import('@ferry/shared').DelegationRun[]>(key);
        if (!current) void cache.invalidateQueries({ queryKey: key });
        else {
          const index = current.findIndex((item) => item.id === run.id);
          if (index < 0) cache.setQueryData(key, [...current, run]);
          else {
            const updated = current.slice();
            updated[index] = run;
            cache.setQueryData(key, updated);
          }
        }
        if (run.status === 'completed') {
          window.dispatchEvent(
            new CustomEvent('ferry:success-pulse', { detail: { sessionId: run.sessionId } }),
          );
        }
      }),
      client.on('toast', (toast) => {
        if (toast.kind === 'error' || toast.kind === 'warning') pushToast(toast);
      }),
    ];
    return () => {
      off.forEach((unsubscribe) => {
        unsubscribe();
      });
    };
  }, [cache, client, pushToast]);
}
