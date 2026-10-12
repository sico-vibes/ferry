import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { createMockFerryClient } from '@ferry/client';
import type { Profile } from '@ferry/shared';
import { ProfileSetupWizard } from './ProfileSetupWizard';
import { newProfileFrom } from './profileDraft';
afterEach(cleanup);

async function fixture() {
  const client = createMockFerryClient({ behavior: 'test' });
  const base = (await client.profiles.list())[0];
  if (!base) throw new Error('Missing profile fixture');
  return {
    client,
    initial: {
      ...newProfileFrom(base, 'Focused work', 1),
      paidAllowed: false,
      allowedProviders: 'all' as const,
      caps: { ...base.caps, monthlyUsd: null },
    },
    providers: (await client.providers.list()).map((p) => ({
      ...p,
      enabled: true,
      keyStatus: 'valid' as const,
    })),
    models: await client.models.list(),
  };
}

it('guides through a profile, saves once on review and leaves the active profile unchanged', async () => {
  const data = await fixture();
  const active = (await data.client.settings.get()).activeProfileId;
  const save = vi.fn(async (profile: Profile) => {
    await data.client.profiles.save(profile);
  });
  render(<ProfileSetupWizard {...data} onSave={save} onCancel={() => undefined} />);
  const user = userEvent.setup({ delay: null });
  for (let index = 0; index < 5; index++)
    await user.click(screen.getByRole('button', { name: 'Continue' }));
  expect(save).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Save profile' }));
  expect(await screen.findByText('Profile saved')).toBeTruthy();
  expect(save).toHaveBeenCalledTimes(1);
  expect((await data.client.settings.get()).activeProfileId).toBe(active);
});

it('requires a paid cap before proceeding and keeps request preauthorization off', async () => {
  const data = await fixture();
  const save = vi.fn().mockResolvedValue(undefined);
  render(<ProfileSetupWizard {...data} onSave={save} onCancel={() => undefined} />);
  const user = userEvent.setup({ delay: null });
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await user.click(screen.getByRole('checkbox', { name: 'Allow paid models' }));
  expect(screen.getByRole('button', { name: 'Continue' }).hasAttribute('disabled')).toBe(true);
  await user.type(screen.getByRole('spinbutton', { name: 'Monthly spending limit (USD)' }), '5');
  for (let index = 0; index < 3; index++)
    await user.click(screen.getByRole('button', { name: 'Continue' }));
  await user.click(screen.getByRole('button', { name: 'Save profile' }));
  await screen.findByText('Profile saved');
  expect(save.mock.calls[0]?.[0]).toMatchObject({
    paidAllowed: true,
    caps: { monthlyUsd: 5 },
    paidConfirmation: { preauthorize: false },
  });
});

it('saves the selected model restriction and accessible fallback order', async () => {
  const data = await fixture();
  const models = data.models.filter((m) => m.free && m.providerId !== 'opencode').slice(0, 2);
  if (models.length !== 2) throw new Error('Missing free models');
  const refs = models.map((m) => m.ref);
  const save = vi.fn().mockResolvedValue(undefined);
  render(
    <ProfileSetupWizard
      {...data}
      initial={{ ...data.initial, allowedModelRefs: refs }}
      onSave={save}
      onCancel={() => undefined}
    />,
  );
  const user = userEvent.setup({ delay: null });
  for (let index = 0; index < 3; index++)
    await user.click(screen.getByRole('button', { name: 'Continue' }));
  const secondRef = refs[1];
  if (!secondRef) throw new Error('Missing model');
  await user.click(screen.getByRole('button', { name: `Move ${secondRef} up` }));
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await user.click(screen.getByRole('button', { name: 'Save profile' }));
  await screen.findByText('Profile saved');
  expect(save.mock.calls[0]?.[0]).toMatchObject({ allowedModelRefs: [refs[1], refs[0]] });
});

it('moves a dragged model to the dropped position and persists the resulting fallback chain', async () => {
  const data = await fixture();
  const models = data.models
    .filter((model) => model.free && model.providerId !== 'opencode')
    .slice(0, 2);
  const first = models[0],
    second = models[1];
  if (!first || !second) throw new Error('Missing model fixtures');
  const save = vi.fn().mockResolvedValue(undefined);
  render(
    <ProfileSetupWizard
      {...data}
      initial={{ ...data.initial, allowedModelRefs: [first.ref, second.ref] }}
      onSave={save}
      onCancel={() => undefined}
    />,
  );
  const user = userEvent.setup({ delay: null });
  for (let index = 0; index < 3; index++)
    await user.click(screen.getByRole('button', { name: 'Continue' }));
  const source = screen.getByRole('button', { name: `Move ${second.ref} up` }).closest('li');
  const target = screen.getByRole('button', { name: `Move ${first.ref} down` }).closest('li');
  if (!source || !target) throw new Error('Missing drag targets');
  fireEvent.dragStart(source);
  fireEvent.dragOver(target);
  fireEvent.drop(target);
  fireEvent.dragEnd(source);
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await user.click(screen.getByRole('button', { name: 'Save profile' }));
  await screen.findByText('Profile saved');
  expect(save.mock.calls[0]?.[0]).toMatchObject({
    allowedModelRefs: [second.ref, first.ref],
    fallbackChain: [
      { provider: second.providerId, patterns: [second.ref.slice(second.providerId.length + 1)] },
      { provider: first.providerId, patterns: [first.ref.slice(first.providerId.length + 1)] },
    ],
  });
});
