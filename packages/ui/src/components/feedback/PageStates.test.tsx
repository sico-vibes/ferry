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
    const loading = screen.getByRole('status', { name: 'Loading' });
    expect(loading.getAttribute('aria-busy')).toBe('true');
    expect(loading.querySelectorAll('.ferry-skeleton-content-row')).toHaveLength(2);
    expect(loading.querySelectorAll('.sr-only')).toHaveLength(1);
  });
});
