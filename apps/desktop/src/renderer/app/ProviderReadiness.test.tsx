// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockFerryClient } from '@ferry/client';
import { afterEach, expect, it, vi } from 'vitest';
import { FerryProvider } from '../data/client';
import { ProviderReadiness } from './ProviderReadiness';
afterEach(cleanup);
it('previews results before Apply, preserves custom profiles and restores the previous preset on Undo', async () => {
  const client = createMockFerryClient({ behavior: 'test' }),
    cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const initial = await client.profiles.list(),
    active = (await client.settings.get()).activeProfileId;
  render(
    <FerryProvider client={client}>
      <QueryClientProvider client={cache}>
        <ProviderReadiness />
      </QueryClientProvider>
    </FerryProvider>,
  );
  const user = userEvent.setup({ delay: null });
  await user.click(await screen.findByRole('button', { name: 'Check free providers' }));
  await screen.findByRole('heading', { name: 'Preview: Optimized for this device' });
  expect(await client.profiles.list()).toEqual(initial);
  expect((await client.settings.get()).activeProfileId).toBe(active);
  expect(
    screen.getByText(/One generation per connection measures responsiveness, not coding quality/),
  ).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Apply recommendations' }));
  await waitFor(async () => {
    expect((await client.settings.get()).activeProfileId).not.toBe(active);
  });
  const saved = await client.profiles.list();
  expect(await screen.findByText('Optimized profile is active')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Edit profile' })).toBeTruthy();
  expect(saved.filter((profile) => initial.some((original) => original.id === profile.id))).toEqual(
    initial,
  );
  expect(saved.find((profile) => profile.provenance)?.provenance?.sampleCount).toBeGreaterThan(0);
  await user.click(await screen.findByRole('button', { name: 'Undo' }));
  await waitFor(async () => {
    expect((await client.settings.get()).activeProfileId).toBe(active);
  });
});
it('cancels Core checks and never offers Apply for cancelled results', async () => {
  const client = createMockFerryClient({ behavior: 'test' }),
    cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const progress = { id: 'fixture', running: true, cancelled: false, results: [], error: null };
  vi.spyOn(client.providers, 'checkProgress').mockResolvedValue(progress);
  const cancel = vi.spyOn(client.providers, 'cancelChecks').mockImplementation(() => {
    const stopped = { ...progress, running: false, cancelled: true };
    cache.setQueryData(['provider-check', 'latest'], stopped);
    return Promise.resolve(stopped);
  });
  render(
    <FerryProvider client={client}>
      <QueryClientProvider client={cache}>
        <ProviderReadiness />
      </QueryClientProvider>
    </FerryProvider>,
  );
  await userEvent.click(await screen.findByRole('button', { name: 'Cancel checks' }));
  expect(cancel).toHaveBeenCalledWith('fixture');
  expect(screen.queryByRole('button', { name: 'Apply recommendations' })).toBeNull();
});

it('serializes Apply so duplicate clicks cannot replace the profile captured for Undo', async () => {
  const client = createMockFerryClient({ behavior: 'test' });
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const active = (await client.settings.get()).activeProfileId;
  const original = client.profiles.save.bind(client.profiles);
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const save = vi.spyOn(client.profiles, 'save').mockImplementation(async (profile) => {
    await pending;
    return original(profile);
  });
  render(
    <FerryProvider client={client}>
      <QueryClientProvider client={cache}>
        <ProviderReadiness />
      </QueryClientProvider>
    </FerryProvider>,
  );
  await userEvent.click(await screen.findByRole('button', { name: 'Check free providers' }));
  await screen.findByRole('heading', { name: 'Preview: Optimized for this device' });
  await userEvent.dblClick(screen.getByRole('button', { name: 'Apply recommendations' }));
  await waitFor(() => {
    expect(save).toHaveBeenCalledTimes(1);
  });
  expect(screen.getByRole('button', { name: 'Applying…' }).hasAttribute('disabled')).toBe(true);
  release?.();
  await userEvent.click(await screen.findByRole('button', { name: 'Undo' }));
  await waitFor(async () => {
    expect((await client.settings.get()).activeProfileId).toBe(active);
  });
});
