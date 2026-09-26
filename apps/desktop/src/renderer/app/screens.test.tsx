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
import { createDemoFerryClient } from '@ferry/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FerryProvider } from '../data/client';
import { keys } from '../data/queries';
import { LibraryCanvas } from './LibraryCanvas';
import { OnboardingCanvas } from './OnboardingCanvas';
import { SettingsCanvas } from './SettingsCanvas';
import { useUI } from '../state/ui';

async function renderRoute(
  path: 'library' | 'settings' | 'onboarding',
  client: ReturnType<typeof createDemoFerryClient>,
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
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
  await router.load();
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
    const client = createDemoFerryClient({ speed: 0, latencyMs: 0 });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(keys.workspaces, client.__state().workspaces);
    queryClient.setQueryData([...keys.sessions, ''], client.__state().sessions);
    queryClient.setQueryData(keys.profiles, client.__state().profiles);
    queryClient.setQueryData(['lanes'], client.__state().lanes);
    await renderRoute('library', client, queryClient);
    const user = userEvent.setup({ delay: null });
    const originalUpdate = client.workspaces.update.bind(client.workspaces);
    let resolveSaved: (() => void) | undefined;
    const saved = new Promise<void>((resolve) => {
      resolveSaved = resolve;
    });
    vi.spyOn(client.workspaces, 'update').mockImplementation(async (...args) => {
      const result = await originalUpdate(...args);
      resolveSaved?.();
      return result;
    });
    const input = screen.getByRole('textbox', { name: 'Add gate command' });
    fireEvent.change(input, { target: { value: 'pnpm check' } });
    const form = input.closest('form');
    if (!form) throw new Error('Gate command form was not rendered');
    fireEvent.submit(form);
    expect(screen.getByText('pnpm check')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await saved;
    expect((await client.workspaces.list())[0]?.settings.gateCommands).toContain('pnpm check');
  }, 30_000);

  it('saves edited profile spending caps', async () => {
    const client = createDemoFerryClient({ speed: 0, latencyMs: 0 });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(keys.profiles, client.__state().profiles);
    useUI.getState().setSettingsSection('Profiles');
    await renderRoute('settings', client, queryClient);
    const user = userEvent.setup({ delay: null });
    const originalSave = client.profiles.save.bind(client.profiles);
    let resolveSaved: (() => void) | undefined;
    const saved = new Promise<void>((resolve) => {
      resolveSaved = resolve;
    });
    vi.spyOn(client.profiles, 'save').mockImplementation(async (...args) => {
      const result = await originalSave(...args);
      resolveSaved?.();
      return result;
    });
    await user.click(await screen.findByRole('button', { name: /Best Available/ }));
    await user.clear(screen.getByRole('textbox', { name: 'Daily cap ($)' }));
    await user.type(screen.getByRole('textbox', { name: 'Daily cap ($)' }), '4');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await saved;
    expect(
      (await client.profiles.list()).find((item) => item.name === 'Best Available')?.caps.dailyUsd,
    ).toBe(4);
  }, 30_000);

  it('completes onboarding and persists the chosen defaults', async () => {
    const client = createDemoFerryClient();
    await client.settings.update({ onboardingComplete: false });
    await renderRoute('onboarding', client);
    await userEvent.click(await screen.findByRole('button', { name: /Get started/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await userEvent.click(screen.getByRole('button', { name: 'Skip for now' }));
    await waitFor(async () => {
      expect((await client.settings.get()).onboardingComplete).toBe(true);
    });
  }, 15000);

  it('shows researched reasons for unavailable providers in onboarding', async () => {
    const client = createDemoFerryClient();
    await client.settings.update({ onboardingComplete: false });
    await renderRoute('onboarding', client);
    await userEvent.click(await screen.findByRole('button', { name: /Get started/ }));
    await userEvent.click(screen.getByText('Unavailable'));
    expect(screen.getByText('Kiro')).toBeTruthy();
    expect(screen.getByText('The free API was retired on July 30, 2026.')).toBeTruthy();
  }, 15000);
});
