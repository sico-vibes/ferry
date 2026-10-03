import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CapacitySummary, Session, SessionDetail } from '@ferry/shared';
import { sampleCapacitySummary, sampleSessionDetail } from '@ferry/shared/testing';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { FerryClient } from '@ferry/client';
import { FerryProvider } from './client';
import { useFerryEvents } from './events';
import { keys } from './queries';

function mountEvents() {
  const handlers = new Map<string, (payload: unknown) => void>();
  const client = {
    on: (event: string, handler: (payload: unknown) => void) => {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
  } as unknown as FerryClient;
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  function EventBridge() {
    useFerryEvents();
    return null;
  }

  render(
    <FerryProvider client={client}>
      <QueryClientProvider client={queries}>
        <EventBridge />
      </QueryClientProvider>
    </FerryProvider>,
  );

  return { emit: (event: string, payload: unknown) => handlers.get(event)?.(payload), queries };
}

afterEach(() => {
  cleanup();
});

describe('Ferry event cache updates', () => {
  it('does not write capacity or sessions for repeated identical quota and status events', () => {
    const { emit, queries } = mountEvents();
    const detail: SessionDetail = structuredClone(sampleSessionDetail);
    const session: Session = detail.session;
    const capacity: CapacitySummary = structuredClone(sampleCapacitySummary);
    queries.setQueryData(keys.capacity, capacity);
    queries.setQueryData([...keys.sessions, ''], [session]);
    queries.setQueryData(keys.session(session.id), detail);

    let writes = 0;
    const unsubscribe = queries.getQueryCache().subscribe((event) => {
      if (event.type === 'updated') writes += 1;
    });

    act(() => {
      emit('quota.updated', structuredClone(capacity));
      emit('quota.updated', structuredClone(capacity));
      emit('session.status', structuredClone(session));
      emit('session.status', structuredClone(session));
    });

    unsubscribe();
    expect(writes).toBe(0);
    expect(queries.getQueryData(keys.capacity)).toBe(capacity);
    expect(queries.getQueryData([...keys.sessions, ''])).toEqual([session]);
    expect(queries.getQueryData(keys.session(session.id))).toBe(detail);
  });
});
