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
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createDemoFerryClient } from '@ferry/client';
import { UiV2 } from '@ferry/ui';
import { SessionIdSchema } from '@ferry/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FerryProvider } from '../data/client';
import { SidebarProjects } from './SidebarProjects';
import { useUI } from '../state/ui';

async function mount(onNewChat = vi.fn(), withReply = false) {
  const client = createDemoFerryClient({ speed: 0, latencyMs: 0 });
  const recent = await client.sessions.create({});
  await client.sessions.rename(recent.id, 'Quick question');
  if (withReply) {
    const model = (await client.models.list())[0];
    if (!model) throw new Error('Missing model fixture');
    const sessions = await client.sessions.list();
    vi.spyOn(client.sessions, 'list').mockResolvedValue(
      sessions.map((session) =>
        session.id === recent.id ? { ...session, lastReplyModelRef: model.ref } : session,
      ),
    );
  }
  const root = createRootRoute({ component: Outlet });
  const home = createRoute({
    getParentRoute: () => root,
    path: '/',
    component: () => <SidebarProjects onNewChat={onNewChat} />,
  });
  const router = createRouter({
    routeTree: root.addChildren([home]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  await router.load();
  render(
    <FerryProvider client={client}>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <UiV2.TooltipProvider>
          <RouterProvider router={router} />
        </UiV2.TooltipProvider>
      </QueryClientProvider>
    </FerryProvider>,
  );
  return { client, onNewChat, router, recent };
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('SidebarProjects', () => {
  it('opens model contributions without navigating or changing the selected conversation', async () => {
    const { client, router, recent } = await mount(vi.fn(), true);
    const modelUsage = vi.spyOn(client.sessions, 'modelUsage');
    useUI.getState().openTab({
      id: SessionIdSchema.parse('selected-conversation'),
      title: 'Selected conversation',
    });
    const selected = useUI.getState().activeId;
    const pathname = router.state.location.pathname;
    const icon = await screen.findByRole('button', {
      name: 'Model usage for Quick question',
    });
    await userEvent.click(icon);
    const dialog = await screen.findByRole('dialog', { name: 'Conversation usage' });
    expect(dialog.textContent).toContain('Quick question');
    expect(dialog.textContent).toContain('No project');
    expect(modelUsage).toHaveBeenCalledWith(recent.id);
    expect(router.state.location.pathname).toBe(pathname);
    expect(useUI.getState().activeId).toBe(selected);
  });

  it('lists chats under their project and chats without one under Recents', async () => {
    const { client } = await mount();
    const project = (await client.workspaces.list())[0];
    if (!project) throw new Error('Expected a demo project');
    const projects = await screen.findByRole('region', { name: 'Projects' });
    expect(
      await within(projects).findByRole('button', { name: new RegExp(`^${project.name}`) }),
    ).toBeTruthy();
    const recents = screen.getByRole('region', { name: 'Recents' });
    expect(await within(recents).findByRole('button', { name: 'Quick question' })).toBeTruthy();
    expect(within(projects).queryByRole('button', { name: 'Quick question' })).toBeNull();
  });

  it('starts a new chat inside a project from its row', async () => {
    const { client, onNewChat } = await mount();
    const project = (await client.workspaces.list())[0];
    if (!project) throw new Error('Expected a demo project');
    await userEvent.click(
      await screen.findByRole('button', { name: `New chat in ${project.name}` }),
    );
    expect(onNewChat).toHaveBeenCalledWith(project.id);
  });

  it('collapses a project and remembers it', async () => {
    const { client } = await mount();
    const project = (await client.workspaces.list())[0];
    if (!project) throw new Error('Expected a demo project');
    const toggle = await screen.findByRole('button', { name: new RegExp(`^${project.name}`) });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    await userEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(localStorage.getItem('ferry.sidebar.collapsedProjects')).toContain(project.id);
  });
});
