// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { FerryClient } from '@ferry/client';
import type { SessionId } from '@ferry/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FullOutputDialog } from './FullOutputDialog';

afterEach(cleanup);

describe('FullOutputDialog', () => {
  it('fetches the selected output handle and pages through large output', async () => {
    const readOutput = vi
      .fn()
      .mockResolvedValueOnce({
        text: 'first page',
        start: 0,
        end: 10,
        totalLength: 20,
        hasMore: true,
      })
      .mockResolvedValueOnce({
        text: 'second page',
        start: 10,
        end: 21,
        totalLength: 21,
        hasMore: false,
      });
    const client = { sessions: { readOutput } } as unknown as Pick<FerryClient, 'sessions'>;
    render(
      <FullOutputDialog
        client={client}
        sessionId={'session_1' as SessionId}
        handle="recovery_1"
        onClose={vi.fn()}
      />,
    );

    expect(await screen.findByText('first page')).toBeTruthy();
    expect(readOutput).toHaveBeenNthCalledWith(1, {
      sessionId: 'session_1',
      handle: 'recovery_1',
      range: { start: 0 },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(await screen.findByText('second page')).toBeTruthy();
    expect(readOutput).toHaveBeenNthCalledWith(2, {
      sessionId: 'session_1',
      handle: 'recovery_1',
      range: { start: 10 },
    });
  });
});
