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
    routeTree: root.addChildren([
      home,
      settings,
      onboarding,
      createRoute({
        getParentRoute: () => root,
        path: '/gateway',
        component: () => <div>Gateway route</div>,
      }),
    ]),
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
    await user.click(screen.getByText('Advanced', { selector: 'summary' }));
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
    const user = userEvent.setup({ delay: null });
    for (const title of [
      'Connect a provider',
      'Use Auto',
      'Check readiness',
      'Create a named key',
    ]) {
      await user.click(await screen.findByRole('button', { name: 'Continue' }));
      await screen.findByRole('heading', { name: title });
    }
    await user.click(screen.getByRole('button', { name: 'Create key and continue' }));
    await user.click(await screen.findByRole('button', { name: 'Send verification request' }));
    await user.click(await screen.findByRole('button', { name: 'Finish setup' }));
    await waitFor(async () => {
      const settings = await client.settings.get();
      const autoFree = (await client.profiles.list()).find((item) => item.name === 'Auto-Free');
      expect(settings.onboardingComplete).toBe(true);
      expect(autoFree).toBeDefined();
      expect(settings.activeProfileId).toBe(autoFree?.id);
    });
  }, 15000);

  it('uses shared provider connections and explains the legitimate Zen path', async () => {
    const client = createDemoFerryClient();
    await client.settings.update({ onboardingComplete: false });
    localStorage.removeItem('ferry.onboardingStep');
    await renderRoute('onboarding', client);
    await userEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    expect(await screen.findByText(/Zen’s OpenCode-only free models/)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Manage connection' }).length).toBeGreaterThan(0);
  }, 15000);

  it('resumes setup with the same named key and does not finish when verification fails', async () => {
    const client = createDemoFerryClient({ speed: 0, latencyMs: 0 });
    const key = await client.gateway.createKey({ name: 'Personal API', profile: 'auto-free' });
    const defaults = (await client.settings.get()).onboarding;
    await client.settings.update({
      onboardingComplete: false,
      onboarding: { ...defaults, step: 4, keyId: key.key.id },
    });
    const create = vi.spyOn(client.gateway, 'createKey');
    vi.spyOn(client.gateway, 'testConnection').mockResolvedValue({
      ok: false,
      requestId: null,
      model: null,
      message: 'Connect valid credentials.',
    });
    await renderRoute('onboarding', client);
    await userEvent.click(await screen.findByRole('button', { name: 'Reuse key and continue' }));
    expect(create).not.toHaveBeenCalled();
    await userEvent.click(await screen.findByRole('button', { name: 'Send verification request' }));
    await screen.findByText('Connect valid credentials.');
    expect(screen.queryByRole('button', { name: 'Finish setup' })).toBeNull();
    expect((await client.settings.get()).onboardingComplete).toBe(false);
  });

  it('cancels the journey while retaining resumable progress and keeping the folder optional', async () => {
    const client = createDemoFerryClient({ speed: 0, latencyMs: 0 });
    await client.settings.update({ onboardingComplete: false });
    const folders = vi.spyOn(client.workspaces, 'open');
    await renderRoute('onboarding', client);
    await userEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Set up later' }));
    await screen.findByText('Gateway route');
    expect((await client.settings.get()).onboarding).toMatchObject({ step: 1 });
    expect((await client.settings.get()).onboardingComplete).toBe(false);
    expect(folders).not.toHaveBeenCalled();
  });
  it('clears paid authorization when reusing an onboarding key after disabling backup', async () => {
    const client = createDemoFerryClient({ speed: 0, latencyMs: 0 });
    const key = await client.gateway.createKey({ name: 'Personal API', profile: 'auto-free' });
    await client.gateway.updateKey({ id: key.key.id, patch: { paidBackup: true, budgetUsd: 5 } });
    const defaults = (await client.settings.get()).onboarding;
    await client.settings.update({
      onboardingComplete: false,
      onboarding: { ...defaults, step: 4, keyId: key.key.id, paidBackup: false, budgetUsd: null },
    });
    await renderRoute('onboarding', client);
    await userEvent.click(await screen.findByRole('button', { name: 'Reuse key and continue' }));
    await screen.findByRole('heading', { name: 'Connect and verify' });
    expect(
      (await client.gateway.listKeys()).find((saved) => saved.id === key.key.id),
    ).toMatchObject({ paidBackup: false, budgetUsd: null });
    expect(screen.queryByText('Approve one paid-capable test under a cost ceiling')).toBeNull();
  });
  it('allows Back from Use Auto while the paid spending limit is invalid', async () => {
    const client = createDemoFerryClient({ speed: 0, latencyMs: 0 });
    const defaults = (await client.settings.get()).onboarding;
    await client.settings.update({
      onboardingComplete: false,
      onboarding: { ...defaults, step: 2, paidBackup: true, budgetUsd: null },
    });
    await renderRoute('onboarding', client);
    await userEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    await screen.findByRole('alert');
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    await screen.findByRole('heading', { name: 'Connect a provider' });
    expect((await client.settings.get()).onboarding.step).toBe(1);
  });
});
