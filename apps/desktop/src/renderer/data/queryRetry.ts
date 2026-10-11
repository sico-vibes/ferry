import { RpcError } from '@ferry/client';

/** Retrying a blocked Core queues duplicate work; reconnection invalidates queries itself. */
export function shouldRetryLocalQuery(failureCount: number, error: Error): boolean {
  if (
    error instanceof RpcError &&
    ['timeout', 'unavailable', 'core_restarted'].includes(error.kind)
  )
    return false;
  return failureCount < 1;
}
