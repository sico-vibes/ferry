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
      client.on('session.part', ({ sessionId, part }) => {
        void cache.invalidateQueries({ queryKey: keys.session(sessionId) });
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
      client.on(
        'session.delta',
        ({ sessionId }) => void cache.invalidateQueries({ queryKey: keys.session(sessionId) }),
      ),
      client.on('task.updated', (task) => {
        void cache.invalidateQueries({ queryKey: keys.session(task.sessionId) });
      }),
      client.on('provider.updated', (provider) => {
        pushToast({ kind: 'info', title: `${provider.name} updated`, body: null });
      }),
      client.on('delegation.updated', (run) => {
        void cache.invalidateQueries({ queryKey: ['delegation', run.sessionId] });
        pushToast({ kind: 'info', title: `Delegation ${run.status}`, body: run.lane });
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
