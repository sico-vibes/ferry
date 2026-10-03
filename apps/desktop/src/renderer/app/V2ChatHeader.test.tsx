// @vitest-environment jsdom
import '../styles.css';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { V2ChatHeader } from './V2ChatHeader';
import { getTitlebarOverlayRightReserve } from './titlebarOverlay';

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useRouterState: () => '/s/session_1',
}));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock('../data/client', () => ({
  useFerryClient: () => ({ sessions: { rename: vi.fn(), remove: vi.fn() } }),
}));
vi.mock('../data/queries', () => ({
  keys: { sessions: ['sessions'] },
  useSessions: () => ({ data: [{ id: 'session_1', title: 'Fix flaky tests' }] }),
}));
vi.mock('../state/toasts', () => ({ useToasts: () => ({ push: vi.fn() }) }));
vi.mock('../state/ui', () => {
  const state = {
    tabs: [],
    toggleRight: vi.fn(),
    rightCollapsed: true,
  };
  return { useUI: (selector: (value: typeof state) => unknown) => selector(state) };
});
vi.mock('./SessionPowerControls', () => ({ ApprovalsTray: () => null }));

afterEach(cleanup);

describe('V2ChatHeader', () => {
  it('shows the session title and reserves the right edge for header actions', () => {
    const { container } = render(<V2ChatHeader />);
    expect(screen.getByRole('button', { name: 'Rename session' }).textContent).toBe(
      'Fix flaky tests',
    );
    const header = container.querySelector('.v2-chat-header');
    const title = header?.querySelector('.v2-header-title');
    const actions = header?.querySelector('.v2-header-actions');
    if (!title || !actions) throw new Error('Expected title and actions in chat header');
    expect(title.textContent).toContain('Fix flaky tests');
    expect(actions.classList.contains('v2-header-actions')).toBe(true);
    expect(title.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );

    expect(getTitlebarOverlayRightReserve(false, { x: 0, width: 1300 }, 1440)).toBe(0);
    expect(getTitlebarOverlayRightReserve(true, { x: 0, width: 1300 }, 1440)).toBe(140);
  });
});
