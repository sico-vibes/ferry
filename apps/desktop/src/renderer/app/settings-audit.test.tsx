// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { createMockFerryClient, type FerryClient } from '@ferry/client';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FerryProvider } from '../data/client';
import { useUI } from '../state/ui';
import { NotificationSettings, SettingsCanvas } from './SettingsCanvas';
import { UsageTab } from './explore/Usage';
import { GatewayCanvas } from './gateway/GatewayCanvas';
import { SidebarProjects } from './SidebarProjects';
import type { ReactNode } from 'react';

vi.mock('@tanstack/react-router', async () => ({
  ...(await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router')),
  useNavigate: () => vi.fn(),
  useRouterState: ({
    select,
  }: {
    select: (state: { location: { pathname: string } }) => unknown;
  }) => select({ location: { pathname: '/' } }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function mount(view: ReactNode, client: FerryClient) {
  const router = createRouter({
    routeTree: createRootRoute({ component: () => view }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  await router.load();
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <FerryProvider client={client}>
      <QueryClientProvider client={queries}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </FerryProvider>,
  );
}
afterEach(() => {
  cleanup();
  localStorage.clear();
  useUI.setState({ settingsSection: 'General' });
  delete window.ferryHost;
});

describe('Settings audit', () => {
  it('includes the file shortcuts and keeps the editor out of General', async () => {
    const client = createMockFerryClient({ behavior: 'test' });
    useUI.setState({ settingsSection: 'Shortcuts' });
    await mount(<SettingsCanvas />, client);
    expect(await screen.findByText('Open folder')).toBeTruthy();
    expect(screen.getByText('Search files')).toBeTruthy();
    expect(screen.getByText('Ctrl+O')).toBeTruthy();
    expect(screen.getByText('Ctrl+P')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'General' }));
    expect(screen.queryByLabelText('keybindings.json')).toBeNull();
  });
  it('resets the content scroll on section change', async () => {
    const client = createMockFerryClient({ behavior: 'test' });
    useUI.setState({ settingsSection: 'Routing' });
    const view = await mount(<SettingsCanvas />, client);
    await screen.findByRole('switch', { name: 'Sticky sessions' });
    const content = view.container.querySelector('.v2-settings-content');
    if (!(content instanceof HTMLElement)) throw new Error('Missing settings scroller');
    content.scrollTop = 480;
    fireEvent.click(screen.getByRole('button', { name: 'General' }));
    expect(content.scrollTop).toBe(0);
  });

  it('shows provider and sign-in skeletons until the empty results arrive', async () => {
    const client = createMockFerryClient({ behavior: 'test' });
    const providers = deferred<Awaited<ReturnType<typeof client.providers.list>>>();
    const oauth = deferred<Awaited<ReturnType<typeof client.oauth.list>>>();
    vi.spyOn(client.providers, 'list').mockReturnValue(providers.promise);
    vi.spyOn(client.oauth, 'list').mockReturnValue(oauth.promise);
    useUI.setState({ settingsSection: 'Providers & keys' });
    await mount(<SettingsCanvas />, client);
    const access = screen.getByRole('region', { name: 'Provider access' });
    const logins = screen.getByRole('region', { name: 'Subscription logins' });
    expect(access.querySelector('[aria-busy="true"]')).toBeTruthy();
    expect(logins.querySelector('[aria-busy="true"]')).toBeTruthy();
    expect(screen.queryByText('No providers')).toBeNull();
    expect(screen.queryByText('No sign-ins available.')).toBeNull();
    await act(async () => {
      await Promise.resolve();
      providers.resolve([]);
      oauth.resolve([]);
    });
    expect(await screen.findByText('No providers')).toBeTruthy();
    expect(await screen.findByText('No sign-ins available.')).toBeTruthy();
  });

  it('puts MCP servers and workflows in Integrations', async () => {
    const client = createMockFerryClient({ behavior: 'test' });
    useUI.setState({ settingsSection: 'Integrations' });
    await mount(<SettingsCanvas />, client);
    expect(await screen.findByRole('region', { name: 'MCP servers' })).toBeTruthy();
    expect(await screen.findByText('GitHub')).toBeTruthy();
    expect(await screen.findByText('Local workflows')).toBeTruthy();
    expect(await screen.findByText('Review')).toBeTruthy();
    expect(
      screen.getByText('Inspect changes for bugs, regressions and missing tests.'),
    ).toBeTruthy();
  });

  it('saves the global Caveman input setting and preserves the reply style', async () => {
    const client = createMockFerryClient({ behavior: 'test' });
    const original = (await client.settings.get()).optimizers;
    useUI.setState({ settingsSection: 'Optimizers' });
    await mount(<SettingsCanvas />, client);
    const modes = await screen.findByRole('radiogroup', {
      name: 'Compress older conversation (Caveman)',
    });
    fireEvent.click(within(modes).getByRole('radio', { name: 'Standard' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(async () => {
      expect((await client.settings.get()).optimizers).toEqual({
        ...original,
        cavemanInput: 'standard',
      });
    });
  });

  it('renders desktop notifications in titled cards and waits for preferences', async () => {
    const preferences = deferred<{
      notifyChatFinished: boolean;
      notifyApproval: boolean;
      closeToTray: boolean;
    }>();
    window.ferryHost = { getShellPreferences: vi.fn(() => preferences.promise) } as never;
    const view = render(<NotificationSettings />);
    expect(view.container.querySelector('[aria-busy="true"]')).toBeTruthy();
    expect(screen.queryByRole('switch')).toBeNull();
    await act(async () => {
      await Promise.resolve();
      preferences.resolve({ notifyChatFinished: true, notifyApproval: false, closeToTray: true });
    });
    const card = screen.getByRole('region', { name: 'Notify me' });
    expect(card.classList.contains('settings-group-card')).toBe(true);
    expect(within(card).getAllByRole('switch')).toHaveLength(2);
    expect(screen.getByRole('region', { name: 'Window' })).toBeTruthy();
  });
});

describe('Loading content', () => {
  it('shows a Resets skeleton while capacity is pending', async () => {
    const client = createMockFerryClient({ behavior: 'test' });
    const capacity = deferred<Awaited<ReturnType<typeof client.quota.capacity>>>();
    vi.spyOn(client.quota, 'capacity').mockReturnValue(capacity.promise);
    await mount(<UsageTab />, client);
    const resets = screen.getByRole('region', { name: 'Reset timeline' });
    expect(resets.querySelector('[aria-busy="true"]')).toBeTruthy();
    expect(screen.queryByText('Reset times are not available yet.')).toBeNull();
    await act(async () => {
      await Promise.resolve();
      capacity.resolve(await createMockFerryClient({ behavior: 'test' }).quota.capacity());
    });
    await waitFor(() => {
      expect(
        screen
          .getByRole('region', { name: 'Upcoming quota resets' })
          .querySelector('[aria-busy="true"]'),
      ).toBeNull();
    });
  });

  it('shows a keys table skeleton before the empty Gateway keys result', async () => {
    const client = createMockFerryClient({ behavior: 'test' });
    const keys = deferred<Awaited<ReturnType<typeof client.gateway.listKeys>>>();
    vi.spyOn(client.gateway, 'listKeys').mockReturnValue(keys.promise);
    await mount(<GatewayCanvas />, client);
    const region = screen.getByRole('region', { name: 'Keys' });
    expect(region.querySelector('[aria-busy="true"]')).toBeTruthy();
    expect(screen.queryByText(/No keys yet/)).toBeNull();
    await act(async () => {
      await Promise.resolve();
      keys.resolve([]);
    });
    expect(await screen.findByText(/No keys yet/)).toBeTruthy();
  });

  it('shows chat skeletons before the empty Recents result', async () => {
    const client = createMockFerryClient({ behavior: 'test' });
    const chats = deferred<Awaited<ReturnType<typeof client.sessions.list>>>();
    vi.spyOn(client.sessions, 'list').mockReturnValue(chats.promise);
    await mount(<SidebarProjects onNewChat={vi.fn()} />, client);
    expect(
      screen.getByRole('region', { name: 'Recents' }).querySelector('[aria-busy="true"]'),
    ).toBeTruthy();
    expect(screen.queryByText('Chats without a project appear here.')).toBeNull();
    await act(async () => {
      await Promise.resolve();
      chats.resolve([]);
    });
    expect(await screen.findByText('Chats without a project appear here.')).toBeTruthy();
  });
});
