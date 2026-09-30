import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockFerryClient } from '@ferry/client';
import type { SessionDetail } from '@ferry/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FerryProvider } from '../data/client';
import { useFerryEvents } from '../data/events';
import { keys } from '../data/queries';
import { useUI } from '../state/ui';
import { HomeCanvas } from './Canvas';

const navigateMock = vi.hoisted(() => vi.fn());
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
}));

function EventBridge() {
  useFerryEvents();
  return null;
}

function mount(ui: React.ReactNode, client = createMockFerryClient({ behavior: 'test' })) {
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <FerryProvider client={client}>
      <QueryClientProvider client={queries}>
        <EventBridge />
        {ui}
      </QueryClientProvider>
    </FerryProvider>,
  );
  return { ...result, client, queries };
}

afterEach(() => {
  cleanup();
  navigateMock.mockReset();
  useUI.setState({
    tabs: [],
    activeId: null,
    leftCollapsed: false,
    rightCollapsed: false,
    rightTab: 'chats',
    density: 'comfortable',
  });
});

describe('Home and session canvases', () => {
  it('patches a sent message into cached session detail without refetching the transcript', async () => {
    const client = createMockFerryClient({ behavior: 'test' });
    const { queries } = mount(<div />, client);
    const session = (await client.sessions.list())[0];
    if (!session) throw new Error('Expected a fixture session');
    const detail = await client.sessions.get(session.id);
    queries.setQueryData(keys.session(session.id), detail);
    const getSession = vi.spyOn(client.sessions, 'get');

    await client.sessions.send(session.id, { text: 'Append without transcript refetch' });

    await waitFor(() => {
      expect(queries.getQueryData<SessionDetail>(keys.session(session.id))?.messages).toHaveLength(
        detail.messages.length + 1,
      );
    });
    expect(getSession).not.toHaveBeenCalled();
  });

  it('creates, sends, opens a tab, and navigates from the Home composer', async () => {
    const client = createMockFerryClient({ behavior: 'test' });
    mount(<HomeCanvas />, client);
    fireEvent.change(await screen.findByRole('textbox', { name: 'Message Ferry' }), {
      target: { value: 'Explain the router' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(async () => {
      const sessions = await client.sessions.list();
      expect(sessions.some((session) => session.preview === 'Explain the router')).toBe(true);
      expect(useUI.getState().tabs).toHaveLength(1);
      const sessionId = useUI.getState().tabs[0]?.id;
      expect(sessionId).toBeTruthy();
      expect(navigateMock).toHaveBeenCalledWith({
        to: '/s/$sessionId',
        params: { sessionId },
      });
    });
  });
});
