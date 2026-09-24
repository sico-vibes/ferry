// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EmptyState, ErrorState, Skeleton } from './PageStates';

describe('page feedback states', () => {
  it('renders an empty state and calls its next step', () => {
    const action = vi.fn();
    render(<EmptyState title="No sessions yet" action="Start a chat" onAction={action} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start a chat' }));
    expect(action).toHaveBeenCalledOnce();
  });
  it('renders an actionable error and loading rows', () => {
    render(
      <>
        <ErrorState title="Provider probe failed" action="Retry" />
        <Skeleton rows={2} />
      </>,
    );
    expect(screen.getByRole('alert').textContent).toContain('Provider probe failed');
    expect(screen.getByRole('status', { name: 'Loading' }).children).toHaveLength(2);
  });
});
