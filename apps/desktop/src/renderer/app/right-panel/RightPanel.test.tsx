import { describe, expect, it } from 'vitest';
import { editedAt } from './RightPanel';

describe('editedAt', () => {
  const now = new Date('2026-09-23T12:00:00.000Z').getTime();

  it('formats recent edits with compact relative time', () => {
    expect(editedAt(new Date(now - 2 * 60_000).toISOString(), now)).toBe('Edited 2m ago');
  });

  it('uses a dated timestamp for edits older than a week', () => {
    expect(editedAt('2026-09-01T14:05:00.000Z', now)).toContain('Edited Sep 1');
  });
});
