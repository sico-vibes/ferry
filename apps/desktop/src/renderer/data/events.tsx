import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { keys } from './queries';
import { useFerryClient } from './client';
import { useToasts } from '../state/toasts';
import { useUI } from '../state/ui';

export function useFerryEvents(): void {
  const client = useFerryClient();
  const cache = useQueryClient();
  const pushToast = useToasts((state) => state.push);
  useEffect(() => {
    const off = [
      client.on('quota.updated', (capacity) => cache.setQueryData(keys.capacity, capacity)),
      client.on('session.updated', (session) => {
        void cache.invalidateQueries({ queryKey: keys.sessions });
        void cache.invalidateQueries({ queryKey: keys.session(session.id) });
      }),
      client.on(
        'session.message',
        ({ sessionId }) => void cache.invalidateQueries({ queryKey: keys.session(sessionId) }),
      ),
      client.on('session.part', ({ sessionId, messageId, part }) => {
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
              const messages = current.messages.map((item, index) =>
                index === messageIndex ? updatedMessage : item,
              );
              cache.setQueryData(key, { ...current, messages });
            }
          }
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
        const messages = current.messages.map((item, index) =>
          index === messageIndex ? updatedMessage : item,
        );
        cache.setQueryData(key, { ...current, messages });
      }),
      client.on('task.updated', (task) => {
        void cache.invalidateQueries({ queryKey: keys.session(task.sessionId) });
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
