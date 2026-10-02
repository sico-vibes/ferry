// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createDemoFerryClient } from '@ferry/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FerryProvider } from '../data/client';
import { useFerryEvents } from '../data/events';
import { keys } from '../data/queries';
import { V2Sidebar } from './V2Sidebar';
import { useUI } from '../state/ui';
import { useToasts } from '../state/toasts';
import type { FerryEvents } from '@ferry/client';
import { Composer } from '@ferry/ui';

function EventBridge() {
  useFerryEvents();
  return null;
}

describe('V2Sidebar new chat', () => {
  beforeEach(() => {
    localStorage.clear();
    useUI.getState().setSelectedWorkspace(null);
  });
  afterEach(() => {
    cleanup();
  });

  it('delegates New Chat to the shared handler', async () => {
    const client = createDemoFerryClient({ speed: 0, latencyMs: 0 });
    const workspace = (await client.workspaces.list())[0];
    const settings = await client.settings.get();
    if (!workspace) throw new Error('Workspace fixture missing');
    useUI.getState().setSelectedWorkspace(workspace.id);
    const onNewChat = vi.fn(() => {
      useUI.getState().requestComposerFocus();
    });
    let settingsUpdated: ((payload: FerryEvents['settings.updated']) => void) | undefined;
    const eventClient = {
      ...client,
      on: ((event: keyof FerryEvents, handler: (payload: never) => void) => {
        if (event === 'settings.updated') {
          settingsUpdated = handler as (payload: FerryEvents['settings.updated']) => void;
        }
        return () => undefined;
      }) as typeof client.on,
    };
    const root = createRootRoute({ component: Outlet });
    const home = createRoute({
      getParentRoute: () => root,
      path: '/',
      component: () => {
        const pendingComposerFocus = useUI((state) => state.pendingComposerFocus);
        return (
          <>
            <V2Sidebar onNewChat={onNewChat} />
            <Composer
              value=""
              onChange={() => undefined}
              onSend={() => undefined}
              onStop={() => undefined}
              running={false}
              profileName="Auto-Free"
              focusRequested={pendingComposerFocus}
              onFocusRequestConsumed={() => {
                useUI.getState().consumeComposerFocus();
              }}
            />
          </>
        );
      },
    });
    const session = createRoute({
      getParentRoute: () => root,
      path: '/s/$sessionId',
      component: () => <div>Session route</div>,
    });
    const router = createRouter({
      routeTree: root.addChildren([home, session]),
      history: createMemoryHistory({ initialEntries: ['/'] }),
    });
    await router.load();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(keys.workspaces, [workspace]);
    queryClient.setQueryData(keys.settings, settings);
    queryClient.setQueryData(keys.profiles, await client.profiles.list());
    queryClient.setQueryData(keys.capacity, await client.quota.capacity());
    queryClient.setQueryData(keys.system, await client.system.info());
    render(
      <FerryProvider client={eventClient}>
        <QueryClientProvider client={queryClient}>
          <EventBridge />
          <RouterProvider router={router} />
        </QueryClientProvider>
      </FerryProvider>,
    );

    const newChat = await screen.findByRole('button', { name: 'New chat' });
    useToasts.setState({ items: [] });
    await userEvent.click(newChat);
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Message Ferry' }));
    });
    await userEvent.click(newChat);
    expect(onNewChat).toHaveBeenCalledTimes(2);
    const updatedSettings = await client.settings.update({ theme: 'light' });
    if (!settingsUpdated) throw new Error('Settings event handler was not registered');
    settingsUpdated(updatedSettings);
    expect(queryClient.getQueryData(keys.settings)).toEqual(updatedSettings);
  });
});
