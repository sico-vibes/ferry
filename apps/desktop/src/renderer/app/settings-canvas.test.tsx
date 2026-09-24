// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockFerryClient } from '@ferry/client';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FerryProvider } from '../data/client';
import { useUI } from '../state/ui';
import { SettingsCanvas } from './SettingsCanvas';

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));

function mount(client = createMockFerryClient({ behavior: 'test' })) {
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <FerryProvider client={client}>
      <QueryClientProvider client={queries}>
        <SettingsCanvas />
      </QueryClientProvider>
    </FerryProvider>,
  );
}

afterEach(() => {
  cleanup();
  localStorage.removeItem('ferry.permissionRules');
  useUI.setState({ settingsSection: 'General' });
});

describe('SettingsCanvas', () => {
  it('resets the persisted layout from Settings → General', () => {
    useUI.setState({
      settingsSection: 'General',
      leftCollapsed: true,
      rightCollapsed: true,
      rightWidth: 480,
      bottomOpen: true,
      bottomHeight: 400,
    });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Reset layout' }));
    expect(useUI.getState()).toMatchObject({
      leftCollapsed: false,
      rightCollapsed: false,
      rightWidth: 300,
      bottomOpen: false,
      bottomHeight: 260,
    });
  });

  // BUG (P2): `PermissionsContent` JSON-parses `ferry.permissionRules` but never asserts the
  // result is an array. A persisted value like `{}` survives the try/catch and `rules.map`
  // throws during render, replacing the whole app with the error boundary.
  // Expected: a non-array persisted value falls back to an empty rule list.
  it.fails('renders the Permissions section when persisted rules are not an array', () => {
    localStorage.setItem('ferry.permissionRules', '{}');
    useUI.setState({ settingsSection: 'Permissions' });
    expect(() => mount()).not.toThrow();
  });

  // BUG (P3): the profile editor repeats the "Paid models" setting row twice with identical
  // label, helper and control, so the same option is shown (and toggled) in two places.
  it.fails('shows the paid-models setting exactly once in the profile editor', async () => {
    useUI.setState({ settingsSection: 'Profiles' });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /Best Available/ }));
    await screen.findByText('Edit routing and spending limits.');
    expect(screen.getAllByText('Paid models')).toHaveLength(1);
  });
});
