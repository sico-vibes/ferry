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
  vi.spyOn(client.settings, 'update').mockRejectedValue(new Error('Core offline'));
  await expect(migrateBrowserPreferences(client, await client.settings.get())).rejects.toThrow(
    'offline',
  );
  expect(localStorage.getItem('ferry.logRetention')).toBe('forever');
});
