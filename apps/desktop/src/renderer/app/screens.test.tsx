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
import { keys } from '../data/queries';
import { OnboardingCanvas } from './OnboardingCanvas';
import { SettingsCanvas } from './SettingsCanvas';
import { useUI } from '../state/ui';

async function renderRoute(
  path: 'settings' | 'onboarding',
  client: ReturnType<typeof createDemoFerryClient>,
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  const root = createRootRoute({ component: Outlet });
  const home = createRoute({
    getParentRoute: () => root,
    path: '/',
    component: () => <div>Home route</div>,
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
    routeTree: root.addChildren([home, settings, onboarding]),
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

describe('Settings and onboarding screens', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    cleanup();
  });

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
    // Built-in profiles are read-only apart from roles and fallback order; edit a copy.
    await user.click(await screen.findByRole('button', { name: 'Duplicate to customize' }));
    await user.clear(screen.getByRole('textbox', { name: 'Per day cap ($)' }));
    await user.type(screen.getByRole('textbox', { name: 'Per day cap ($)' }), '4');
    await user.clear(screen.getByRole('textbox', { name: 'Per month cap ($)' }));
    await user.type(screen.getByRole('textbox', { name: 'Per month cap ($)' }), '25');
    await user.click(screen.getByRole('button', { name: 'Save profile' }));
    await saved;
    const savedProfile = (await client.profiles.list()).find(
      (item) => item.name === 'Best Available copy',
    );
    expect(savedProfile?.caps.dailyUsd).toBe(4);
    expect(savedProfile?.caps.monthlyUsd).toBe(25);
    expect(await screen.findByRole('status', { name: 'Saved' })).toBeTruthy();
  }, 30_000);

  it('completes onboarding and persists the default profile', async () => {
    const client = createDemoFerryClient();
    await client.settings.update({ onboardingComplete: false });
    localStorage.removeItem('ferry.onboardingStep');
    await renderRoute('onboarding', client);
    await userEvent.click(await screen.findByRole('button', { name: 'Skip setup' }));
    await waitFor(async () => {
      const settings = await client.settings.get();
      const autoFree = (await client.profiles.list()).find((item) => item.name === 'Auto-Free');
      expect(settings.onboardingComplete).toBe(true);
      expect(autoFree).toBeDefined();
      expect(settings.activeProfileId).toBe(autoFree?.id);
    });
  }, 15000);

  it('shows researched reasons for unavailable providers in onboarding', async () => {
    const client = createDemoFerryClient();
    await client.settings.update({ onboardingComplete: false });
    localStorage.removeItem('ferry.onboardingStep');
    await renderRoute('onboarding', client);
    await userEvent.click(await screen.findByRole('button', { name: 'Continue on this device' }));
    await userEvent.click(screen.getByText('Unavailable'));
    expect(screen.getByText('Kiro')).toBeTruthy();
    expect(screen.getByText('The free API was retired on July 30, 2026.')).toBeTruthy();
  }, 15000);
});
