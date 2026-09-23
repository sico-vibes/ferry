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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FerryProvider } from '../data/client';
import { LibraryCanvas } from './LibraryCanvas';
import { OnboardingCanvas } from './OnboardingCanvas';
import { SettingsCanvas } from './SettingsCanvas';

function renderRoute(
  path: 'library' | 'settings' | 'onboarding',
  client: ReturnType<typeof createDemoFerryClient>,
) {
  const root = createRootRoute({ component: Outlet });
  const home = createRoute({
    getParentRoute: () => root,
    path: '/',
    component: () => <div>Home route</div>,
  });
  const library = createRoute({
    getParentRoute: () => root,
    path: '/library',
    component: LibraryCanvas,
  });
  const settings = createRoute({
    getParentRoute: () => root,
    path: '/settings',
    component: SettingsCanvas,
  });
  const onboarding = createRoute({
    getParentRoute: () => root,
    path: '/onboarding',
    component: OnboardingCanvas,
  });
  const router = createRouter({
    routeTree: root.addChildren([home, library, settings, onboarding]),
    history: createMemoryHistory({ initialEntries: [`/${path}`] }),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <FerryProvider client={client}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </FerryProvider>,
  );
}

describe('Library, settings, and onboarding screens', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    cleanup();
  });

  it('saves workspace gate command settings', async () => {
    const client = createDemoFerryClient();
    renderRoute('library', client);
    const input = await screen.findByRole('textbox', { name: 'Add gate command' });
    await userEvent.type(input, 'pnpm check{Enter}');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(async () => {
      expect((await client.workspaces.list())[0]?.settings.gateCommands).toContain('pnpm check');
    });
  }, 15000);

  it('saves edited profile spending caps', async () => {
    const client = createDemoFerryClient();
    renderRoute('settings', client);
    await userEvent.click(await screen.findByRole('button', { name: 'Profiles' }));
    await userEvent.click(await screen.findByRole('button', { name: /Best Available/ }));
    await userEvent.clear(screen.getByRole('textbox', { name: 'Daily cap ($)' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Daily cap ($)' }), '4');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(async () => {
      expect(
        (await client.profiles.list()).find((item) => item.name === 'Best Available')?.caps
          .dailyUsd,
      ).toBe(4);
    });
  }, 15000);

  it('completes onboarding and persists the chosen defaults', async () => {
    const client = createDemoFerryClient();
    await client.settings.update({ onboardingComplete: false });
    renderRoute('onboarding', client);
    await userEvent.click(await screen.findByRole('button', { name: /Get started/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await userEvent.click(screen.getByRole('button', { name: 'Skip for now' }));
    await waitFor(async () => {
      expect((await client.settings.get()).onboardingComplete).toBe(true);
    });
  }, 15000);
});
