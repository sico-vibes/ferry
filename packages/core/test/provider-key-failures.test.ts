import { describe, expect, it, vi } from 'vitest';
import type { ProviderKeyEntry } from '@ferry/storage';
import type { FerryServices } from '../src/services.js';
import { recordProviderKeyFailure } from '../src/services.js';

const entry: ProviderKeyEntry = {
  id: 'openai:1',
  providerId: 'openai',
  keyId: '1',
  label: 'Primary',
  position: 0,
  enabled: true,
  status: 'ok',
  lastError: null,
  cooldownUntil: null,
  keyringRef: 'openai:1',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('provider key failure persistence', () => {
  it('persists a Retry-After deadline on only the failed key entry', () => {
    const put = vi.fn();
    const now = new Date('2026-06-01T10:00:00.000Z');
    const services = {
      providers: { get: () => undefined },
      providerKeyEntries: { put },
      clock: { now: () => now },
    } as unknown as FerryServices;

    recordProviderKeyFailure(services, entry, 429, 'rate limited', '2026-06-01T10:00:30.000Z');

    expect(put).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'openai:1',
        status: 'rate_limited',
        cooldownUntil: '2026-06-01T10:00:30.000Z',
      }),
    );
  });

  it('marks invalid credentials on the individual key', () => {
    const put = vi.fn();
    const services = {
      providers: { get: () => undefined },
      providerKeyEntries: { put },
      clock: { now: () => new Date('2026-06-01T10:00:00.000Z') },
    } as unknown as FerryServices;

    recordProviderKeyFailure(services, { ...entry, id: 'openai:2', keyId: '2' }, 401, 'invalid');

    expect(put).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'openai:2', status: 'invalid' }),
    );
  });
});
