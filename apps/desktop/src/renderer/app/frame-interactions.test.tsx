import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockFerryClient } from '@ferry/client';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FerryProvider } from '../data/client';
import { useFerryEvents } from '../data/events';
import { Sidebar } from './Sidebar';
import { RightPanel } from './right-panel/RightPanel';
import { useUI } from '../state/ui';
import { clampBottomHeight, clampRightWidth, parsePersistedLayout } from '../state/ui';
import { mockShellOutput } from './BottomPanel';

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
    rightWidth: 300,
    bottomOpen: false,
    bottomHeight: 260,
    bottomTab: 'terminal',
  });
});

describe('desktop frame interactions', () => {
  it('clamps, persists, and toggles the resizable panel state', () => {
    expect(clampRightWidth(120)).toBe(300);
    expect(clampRightWidth(700)).toBe(560);
    expect(clampBottomHeight(100)).toBe(200);
    expect(clampBottomHeight(600)).toBe(480);
    useUI.getState().setRightWidth(410);
    useUI.getState().setBottomHeight(330);
    useUI.getState().toggleBottom();
    expect(useUI.getState().bottomOpen).toBe(true);
    const persisted = JSON.parse(localStorage.getItem('ferry.ui') ?? '{}') as {
      rightWidth?: number;
      bottomHeight?: number;
      bottomOpen?: boolean;
    };
    expect(persisted).toMatchObject({ rightWidth: 410, bottomHeight: 330, bottomOpen: true });
  });

  it('validates persisted layout values and restores the default layout', () => {
    expect(
      parsePersistedLayout({
        leftCollapsed: true,
        rightCollapsed: false,
        rightWidth: 900,
        bottomOpen: true,
        bottomHeight: 140,
        bottomTab: 'agent-log',
      }),
    ).toEqual({
      leftCollapsed: true,
      rightCollapsed: false,
      rightWidth: 560,
      bottomOpen: true,
      bottomHeight: 200,
      bottomTab: 'agent-log',
    });
    expect(parsePersistedLayout({ leftCollapsed: 'collapsed', rightWidth: Number.NaN })).toEqual({
      leftCollapsed: false,
      rightCollapsed: false,
      rightWidth: 300,
      bottomOpen: false,
      bottomHeight: 260,
      bottomTab: 'terminal',
    });

    useUI.getState().toggleLeft();
    useUI.getState().toggleRight();
    useUI.getState().setRightWidth(480);
    useUI.getState().toggleBottom();
    useUI.getState().resetLayout();
    expect(useUI.getState()).toMatchObject({
      leftCollapsed: false,
      rightCollapsed: false,
      rightWidth: 300,
      bottomOpen: false,
      bottomHeight: 260,
      bottomTab: 'terminal',
    });
  });

  it('returns canned output from the mock shell', () => {
    expect(mockShellOutput('git status')).toContain('working tree clean');
    expect(mockShellOutput('ls')).toContain('packages');
    expect(mockShellOutput('nonsense')).toBe('mock shell: command not available in demo');
  });

  it('routes rail navigation to Explore', async () => {
    mount(<Sidebar />);
    await screen.findByText('Best Available');
    fireEvent.click(screen.getByRole('button', { name: 'Explore' }));
    expect(navigateMock).toHaveBeenCalledWith({ to: '/explore' });
  });

  it('switches sidebar content for Library, Explore, and Settings destinations', async () => {
    const library = mount(<Sidebar activeNav="library" />);
    expect(await screen.findByRole('button', { name: /Open folder/ })).toBeTruthy();
    expect(await screen.findByText('ferry-web')).toBeTruthy();
    library.unmount();
    mount(<Sidebar activeNav="explore" />);
    expect(await screen.findByRole('navigation', { name: 'Provider filters' })).toBeTruthy();
    expect(await screen.findByText(/Gemini API/)).toBeTruthy();
    cleanup();
    mount(<Sidebar activeNav={null} />);
    expect(await screen.findByRole('navigation', { name: 'Settings sections' })).toBeTruthy();
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
    await screen.findByRole('button', {
      name: new RegExp(`${String(updated.stepsLeftToday)} steps left today`),
    });
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
