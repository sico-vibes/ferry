import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockFerryClient } from '@ferry/client';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FerryProvider } from '../data/client';
import { useFerryEvents } from '../data/events';
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
  });
});

describe('Home and session canvases', () => {
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
