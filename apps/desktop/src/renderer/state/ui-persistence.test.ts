import { describe, expect, it, vi } from 'vitest';

async function loadUI(raw?: string) {
  vi.resetModules();
  localStorage.clear();
  if (raw !== undefined) localStorage.setItem('ferry.ui', raw);
  return import('./ui');
}

describe('ui store persistence', () => {
  it('restores valid persisted tabs and the active tab', async () => {
    const { useUI } = await loadUI(
      JSON.stringify({
        tabs: [{ id: 'session_a', title: 'Alpha' }],
        activeId: 'session_a',
        rightTab: 'plan',
        density: 'compact',
      }),
    );
    expect(useUI.getState().tabs).toEqual([{ id: 'session_a', title: 'Alpha' }]);
    expect(useUI.getState().activeId).toBe('session_a');
    expect(useUI.getState().rightTab).toBe('plan');
    expect(useUI.getState().density).toBe('compact');
  });

  it('falls back to an empty tab list when the persisted value is not an array', async () => {
    const { useUI } = await loadUI(JSON.stringify({ tabs: 'not-an-array' }));
    expect(useUI.getState().tabs).toEqual([]);
  });

  // BUG (P2): a persisted `ferry.ui` whose `tabs` array contains a non-object entry
  // (e.g. `[null]`) is restored verbatim, and AppFrame dereferences `tab.id` while
  // building the tab bar, throwing so the whole app renders the "Something went wrong!" boundary.
  // Expected: invalid tab entries are filtered out; observed: the entry survives into state.
  it('drops non-object entries from the persisted tab list', async () => {
    const { useUI } = await loadUI(
      JSON.stringify({ tabs: [null, { id: 'session_a', title: 'Alpha' }] }),
    );
    expect(useUI.getState().tabs).toEqual([{ id: 'session_a', title: 'Alpha' }]);
  });

  // BUG (P3): `parsePersistedLayout` accepts `rightTab: 'terminal'` but the right panel only
  // renders the chats/plan/changes tabs, so the restored value leaves the panel with no active tab.
  it('rejects the unsupported persisted right panel tab "terminal"', async () => {
    const { useUI } = await loadUI(JSON.stringify({ rightTab: 'terminal' }));
    expect(useUI.getState().rightTab).toBe('chats');
  });
});
