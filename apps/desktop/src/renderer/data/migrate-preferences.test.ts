import { beforeEach, expect, it, vi } from 'vitest';
import { createMockFerryClient } from '@ferry/client';
import { migrateBrowserPreferences } from './migrate-preferences';

beforeEach(() => {
  localStorage.clear();
});
it('migrates valid rules and retention once and removes browser values only after saving', async () => {
  const client = createMockFerryClient({ behavior: 'test' });
  localStorage.setItem(
    'ferry.permissionRules',
    JSON.stringify([{ effect: 'deny', tool: 'run_command', pattern: 'git push*' }, { bad: true }]),
  );
  localStorage.setItem('ferry.logRetention', '7');
  const update = vi.spyOn(client.settings, 'update');
  const saved = await migrateBrowserPreferences(client, await client.settings.get());
  expect(saved.permissionRules).toEqual([
    { effect: 'deny', tool: 'run_command', pattern: 'git push*' },
  ]);
  expect(saved.logRetentionDays).toBe(7);
  expect(localStorage.getItem('ferry.permissionRules')).toBeNull();
  await migrateBrowserPreferences(client, saved);
  expect(update).toHaveBeenCalledTimes(1);
});
it('keeps preferences available for retry when Core rejects migration', async () => {
  const client = createMockFerryClient({ behavior: 'test' });
  localStorage.setItem('ferry.logRetention', 'forever');
  const offline = new Error('Core offline');
  const update = vi.spyOn(client.settings, 'update').mockRejectedValueOnce(offline);
  const settings = await client.settings.get();
  // Vitest's .rejects getter fails under Node 24.21 + jsdom. Assert the outcome
  // directly, including rejection identity, without masking a fulfilled migration.
  const outcome = await migrateBrowserPreferences(client, settings).then(
    () => ({ status: 'fulfilled' as const }),
    (error: unknown) => ({ status: 'rejected' as const, error }),
  );
  expect(outcome.status).toBe('rejected');
  if (outcome.status === 'rejected') expect(outcome.error).toBe(offline);
  expect(localStorage.getItem('ferry.logRetention')).toBe('forever');
  expect((await client.settings.get()).browserPreferencesMigrated).toBe(false);

  const saved = await migrateBrowserPreferences(client, settings);
  expect(saved.logRetentionDays).toBeNull();
  expect(saved.browserPreferencesMigrated).toBe(true);
  expect(localStorage.getItem('ferry.logRetention')).toBeNull();
  expect(update).toHaveBeenCalledTimes(2);
});
