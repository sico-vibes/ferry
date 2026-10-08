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
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMockFerryClient } from '@ferry/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FerryProvider } from '../data/client';
import { useComposerInsert } from '../data/composerInsert';
import { useUI } from '../state/ui';
import { CommandPalette } from './SessionPowerControls';
import { useState } from 'react';

function ComposerProbe() {
  const [text, setText] = useState('Look at');
  useComposerInsert(setText);
  return <output aria-label="Composer text">{text}</output>;
}

async function mount() {
  const client = createMockFerryClient({ behavior: 'test' });
  const project = (await client.workspaces.list())[0];
  if (!project) throw new Error('Expected a mock project');
  useUI.getState().setSelectedWorkspace(project.id);
  const searchFiles = vi
    .spyOn(client.workspaces, 'searchFiles')
    .mockResolvedValue([{ path: 'src/app/main.ts', name: 'main.ts' }]);
  const root = createRootRoute({ component: Outlet });
  const home = createRoute({
    getParentRoute: () => root,
    path: '/',
    component: () => (
      <>
        <CommandPalette onNewChat={() => Promise.resolve()} />
        <ComposerProbe />
      </>
    ),
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
        <RouterProvider router={router} />
      </QueryClientProvider>
    </FerryProvider>,
  );
  return { project, searchFiles };
}

afterEach(() => {
  cleanup();
  useUI.getState().setSelectedWorkspace(null);
});

describe('Search files (Ctrl+P)', () => {
  it('searches the current project and inserts an @mention into the composer', async () => {
    const { project, searchFiles } = await mount();
    fireEvent.keyDown(window, { key: 'p', ctrlKey: true });
    const input = await screen.findByPlaceholderText(`Search files in ${project.name}`);
    await userEvent.type(input, 'main');
    await waitFor(() => {
      expect(searchFiles).toHaveBeenLastCalledWith(
        expect.objectContaining({ workspaceId: project.id, query: 'main' }),
      );
    });
    await userEvent.click(await screen.findByRole('option', { name: /main\.ts/ }));
    await waitFor(() => {
      expect(screen.getByLabelText('Composer text').textContent).toBe('Look at @src/app/main.ts ');
    });
  });
});
