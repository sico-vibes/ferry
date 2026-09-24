// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DelegationRun, RunId, SessionId } from '@ferry/shared';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FerryClient } from '@ferry/client';
import { FerryProvider } from '../data/client';
import { ReviewCanvas } from './ReviewCanvas';

const params = vi.hoisted(() => ({ sessionId: 'session_1', runId: 'run_1' }));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useParams: () => params,
}));

function run(overrides: Partial<DelegationRun> = {}): DelegationRun {
  return {
    id: 'run_1' as RunId,
    sessionId: 'session_1' as SessionId,
    lane: 'Codex',
    implementer: 'codex',
    brief: 'Apply the change',
    status: 'completed',
    startedAt: '2026-09-23T10:00:00.000Z',
    finishedAt: '2026-09-23T10:01:00.000Z',
    progress: [],
    finalMessage: 'Done',
    touchedFiles: [],
    gateResults: [{ command: 'pnpm check', ok: true, outputTail: 'ok' }],
    usage: null,
    decision: null,
    ...overrides,
  };
}

function mount(runs: DelegationRun[]) {
  const client = {
    delegation: { runs: vi.fn().mockResolvedValue(runs) },
    on: vi.fn(() => () => undefined),
  } as unknown as FerryClient;
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <FerryProvider client={client}>
      <QueryClientProvider client={queries}>
        <ReviewCanvas />
      </QueryClientProvider>
    </FerryProvider>,
  );
}

afterEach(cleanup);

describe('ReviewCanvas', () => {
  it('renders the run lane, gate results and empty-file state', async () => {
    mount([run()]);
    expect(await screen.findByText('Codex')).toBeTruthy();
    expect(screen.getByText('No changed files in this run.')).toBeTruthy();
    expect(screen.getByText(/pnpm check/)).toBeTruthy();
  });

  // BUG (P3): a delegation run id that does not exist (stale link, refreshed URL, deleted run)
  // leaves the review canvas stuck on "Loading review…" forever, because the component cannot
  // distinguish "still loading" from "no such run".
  // Expected: a not-found/empty state; observed: perpetual loading text.
  it('shows a not-found state when the delegation run does not exist', async () => {
    mount([]);
    expect(
      await screen.findByText(/not found|no longer available|missing/i, {}, { timeout: 1500 }),
    ).toBeTruthy();
  });
});
