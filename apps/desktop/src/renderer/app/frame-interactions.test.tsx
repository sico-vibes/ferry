import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockFerryClient } from '@ferry/client';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FerryProvider } from '../data/client';
import { useFerryEvents } from '../data/events';
import { Sidebar } from './Sidebar';
import { RightPanel } from './right-panel/RightPanel';
import { useUI } from '../state/ui';

const navigateMock = vi.hoisted(() => vi.fn());
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigateMock }));

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
  useUI.setState({
    tabs: [],
    activeId: null,
    leftCollapsed: false,
    rightCollapsed: false,
    rightTab: 'chats',
  });
});

describe('desktop frame interactions', () => {
  it('routes rail navigation to Explore', async () => {
    mount(<Sidebar />);
    await screen.findByText('Best Available');
    fireEvent.click(screen.getByRole('button', { name: 'Explore' }));
    expect(navigateMock).toHaveBeenCalledWith({ to: '/explore' });
  });

  it('creates a session and opens a tab from New Chat', async () => {
    mount(<Sidebar />);
    await screen.findByText('Best Available');
    fireEvent.click(screen.getByRole('button', { name: 'New Chat' }));
    await waitFor(() => {
      expect(useUI.getState().tabs).toHaveLength(1);
    });
    expect(useUI.getState().tabs[0]?.title).toBe('New Chat');
  });

  it('activates the selected pinned profile', async () => {
    mount(<Sidebar />);
    const fast = await screen.findByRole('button', { name: 'Fast' });
    fireEvent.click(fast);
    await waitFor(() => {
      expect(fast.getAttribute('aria-current')).toBe('true');
    });
  });

  it('updates the live capacity card from quota events', async () => {
    const client = createMockFerryClient({ behavior: 'test' });
    mount(<Sidebar />, client);
    await screen.findByText('Best Available');
    const capacity = await client.quota.capacity();
    const provider = client.__store().providers[0];
    if (!provider) throw new Error('No provider fixtures available');
    act(() => {
      client.__store().consumeSteps(provider.id, 20);
    });
    const updated = await client.quota.capacity();
    if (updated.stepsLeftToday === capacity.stepsLeftToday)
      throw new Error('Expected the test quota to change');
    await screen.findByText(`≈ ${String(updated.stepsLeftToday)} steps left today`);
  });

  it('filters chats from the right panel search field', async () => {
    mount(<RightPanel onNewChat={() => undefined} />);
    await screen.findByText('Auth refactor');
    fireEvent.change(screen.getByRole('textbox', { name: 'Search chats' }), {
      target: { value: 'Auth refactor' },
    });
    await waitFor(() => {
      expect(screen.getByText('Auth refactor')).toBeTruthy();
      expect(screen.queryByText('Fix flaky tests')).toBeNull();
    });
  });

  it('moves a chat into Saved topics when starred', async () => {
    mount(<RightPanel onNewChat={() => undefined} />);
    const save = await screen.findByRole('button', { name: 'Save Fix flaky tests' });
    fireEvent.click(save);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Unsave Fix flaky tests' })).toBeTruthy();
    });
    const savedSection = screen.getByText('Saved topics').closest('section');
    expect(savedSection && within(savedSection).getByText('Fix flaky tests')).toBeTruthy();
  });
});
