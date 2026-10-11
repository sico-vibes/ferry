import { expect, it } from 'vitest';
import { RpcError } from '@ferry/client';
import { shouldRetryLocalQuery } from './queryRetry';

it('does not repeat requests against a timed-out or disconnected local engine', () => {
  for (const kind of ['timeout', 'unavailable', 'core_restarted'])
    expect(shouldRetryLocalQuery(0, new RpcError('Engine unavailable', -32001, kind))).toBe(false);
});

it('allows one retry for other transient errors and then shows the recovery action', () => {
  const error = new Error('Transient read failure');
  expect(shouldRetryLocalQuery(0, error)).toBe(true);
  expect(shouldRetryLocalQuery(1, error)).toBe(false);
});
