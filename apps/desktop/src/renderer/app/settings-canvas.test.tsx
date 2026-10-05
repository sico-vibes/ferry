// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockFerryClient } from '@ferry/client';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FerryProvider } from '../data/client';
import { useUI } from '../state/ui';
import { DEFAULT_LAYOUT } from '../state/ui-layout';
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
  delete window.ferryHost;
  delete window.ferryEngineHello;
  delete window.ferryRpcClient;
});

describe('SettingsCanvas', () => {
  it('renders a searchable section list and each section as a second-level heading', async () => {
    const sections = [
      ['General', 'General'],
      ['Profiles', 'Profiles'],
      ['Providers & keys', 'Providers & keys'],
      ['Routing', 'Routing'],
      ['Optimizers', 'Optimizers'],
      ['Delegation', 'Delegation'],
      ['Permissions', 'Permissions'],
      ['Gateway', 'Gateway'],
      ['Data & privacy', 'Data & privacy'],
      ['Shortcuts', 'Shortcuts'],
      ['About', 'About'],
    ] as const;

    for (const [section, title] of sections) {
      cleanup();
      useUI.setState({ settingsSection: section });
      mount();
      // The Settings dialog supplies the "Settings" title; the canvas owns section headings.
      expect(await screen.findByRole('textbox', { name: 'Search settings' })).toBeTruthy();
      expect(await screen.findByRole('heading', { name: title, level: 2 })).toBeTruthy();
    }
  });

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
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(useUI.getState()).toMatchObject({
      ...DEFAULT_LAYOUT,
    });
  });

  it('shows user-toggleable routing techniques and persists changes through settings', async () => {
    const client = createMockFerryClient({ behavior: 'test' });
    const user = userEvent.setup();
    useUI.setState({ settingsSection: 'Routing' });
    mount(client);
    const toggle = await screen.findByRole('switch', { name: 'Sticky sessions' });
    expect(toggle.getAttribute('data-state')).toBe('checked');
    await user.click(toggle);
    await user.click(await screen.findByRole('button', { name: 'Save changes' }));
    await waitFor(async () => {
      expect((await client.settings.get()).routing.stickySessions).toBe(false);
    });
    expect(screen.getByRole('status').textContent).toBe('Saved');
    expect(
      screen.getByText(
        "Reserve capacity before sending so parallel tasks don't overshoot a provider's limits.",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByText('Tune'));
    expect(screen.getByRole('slider', { name: 'Quota ramp start' })).toBeTruthy();
  });

  it('shows setting save failures inline', async () => {
    const client = createMockFerryClient({ behavior: 'test' });
    vi.spyOn(client.settings, 'update').mockRejectedValue(new Error('Storage is unavailable'));
    useUI.setState({ settingsSection: 'Routing' });
    mount(client);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('switch', { name: 'Sticky sessions' }));
    await user.click(screen.getByRole('button', { name: /^Save changes$/ }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Could not save: Storage is unavailable',
    );
  });

  it('persists the planner/editor split on an individual profile', async () => {
    const client = createMockFerryClient({ behavior: 'test' });
    useUI.setState({ settingsSection: 'Profiles' });
    const user = userEvent.setup();
    mount(client);
    await user.click(await screen.findByRole('combobox', { name: 'Profile to edit' }));
    await user.click(await screen.findByRole('option', { name: /Auto-Free/ }));
    const toggle = await screen.findByRole('switch', { name: 'Split planning and editing' });
    expect(toggle.getAttribute('data-state')).toBe('checked');
    await user.click(toggle);
    await user.click(screen.getByRole('button', { name: 'Save profile' }));
    await waitFor(async () => {
      expect(
        (await client.profiles.list()).find((profile) => profile.name === 'Auto-Free')?.roles
          .enabled,
      ).toBe(false);
    });
  });

  it('keeps training-provider avoidance off by default and persists the privacy toggle', async () => {
    const client = createMockFerryClient({ behavior: 'test' });
    const user = userEvent.setup();
    useUI.setState({ settingsSection: 'Data & privacy' });
    mount(client);
    const toggle = await screen.findByRole('switch', {
      name: 'Avoid providers that train on my prompts',
    });
    expect(toggle.getAttribute('data-state')).toBe('unchecked');
    await user.click(toggle);
    await user.click(await screen.findByRole('button', { name: 'Save changes' }));
    await waitFor(async () => {
      expect((await client.settings.get()).routing.avoidTrainingProviders).toBe(true);
    });
  });

  it('persists trial-credit opt-ins per provider from Providers & keys', async () => {
    const client = createMockFerryClient({ behavior: 'test' });
    const originalList = client.providers.list.bind(client.providers);
    vi.spyOn(client.providers, 'list').mockImplementation(async () =>
      (await originalList()).map((provider) =>
        provider.id === 'cerebras' ? { ...provider, tag: 'trial' } : provider,
      ),
    );
    useUI.setState({ settingsSection: 'Providers & keys' });
    const user = userEvent.setup();
    mount(client);
    const toggle = await screen.findByRole('switch', {
      name: 'Use trial credits for Cerebras',
    });
    expect(toggle.getAttribute('data-state')).toBe('unchecked');
    await user.click(toggle);
    await user.click(await screen.findByRole('button', { name: 'Save changes' }));
    await waitFor(async () => {
      expect((await client.settings.get()).routing.trialOptInProviders).toContain('cerebras');
    });
  });

  // BUG (P2): `PermissionsContent` JSON-parses `ferry.permissionRules` but never asserts the
  // result is an array. A persisted value like `{}` survives the try/catch and `rules.map`
  // throws during render, replacing the whole app with the error boundary.
  // Expected: a non-array persisted value falls back to an empty rule list.
  it('renders the Permissions section when persisted rules are not an array', () => {
    localStorage.setItem('ferry.permissionRules', '{}');
    useUI.setState({ settingsSection: 'Permissions' });
    expect(() => mount()).not.toThrow();
  });

  it('shows the paid-models setting exactly once in the profile editor', async () => {
    useUI.setState({ settingsSection: 'Profiles' });
    mount();
    await screen.findByRole('combobox', { name: 'Profile to edit' });
    expect(screen.getAllByText('Allow paid models')).toHaveLength(1);
  });

  it('hides the internal No profile entry and locks built-in fields', async () => {
    useUI.setState({ settingsSection: 'Profiles' });
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole('combobox', { name: 'Profile to edit' }));
    expect(screen.queryByRole('option', { name: /No profile/ })).toBeNull();
    await user.keyboard('{Escape}');
    expect(await screen.findByRole('note')).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Allow paid models' }).matches(':disabled')).toBe(
      true,
    );
  });

  it('shows the connected core details and disables domains with no registered handlers', async () => {
    useUI.setState({ settingsSection: 'About' });
    window.ferryHost = {
      versions: { app: '0.9.0', electron: '40.0.0' },
      getUpdateState: vi.fn().mockResolvedValue({
        status: 'idle',
        version: null,
        error: null,
        autoDownload: true,
      }),
      onUpdateState: vi.fn(() => () => undefined),
      getEngineStatus: vi.fn().mockResolvedValue({ status: 'connected', pid: 4321 }),
    } as never;
    window.ferryEngineHello = {
      protocol: 'ferry/1',
      capabilities: ['events', 'selfTest'],
      realDomains: [],
      implementedMethods: [],
    };
    window.ferryRpcClient = {
      system: {
        info: vi.fn(),
        selfTest: vi.fn().mockResolvedValue({
          modules: [
            { name: 'better-sqlite3', ok: false, version: null, error: 'MODULE_NOT_FOUND' },
            { name: 'node-pty', ok: true, version: 'loaded', error: null },
            { name: '@napi-rs/keyring', ok: false, version: null, error: 'ABI mismatch' },
          ],
        }),
      },
    } as never;
    mount();
    fireEvent.click(screen.getByText('Developer diagnostics'));
    expect((await screen.findByText('connected')).textContent).toBe('connected');
    expect(screen.getByText('connected · PID 4321 · ferry/1').textContent).toContain('4321');
    expect(
      (await screen.findByText('better-sqlite3: failed: MODULE_NOT_FOUND')).textContent,
    ).toContain('MODULE_NOT_FOUND');
    // Domains without a registered core handler cannot be switched to Real.
    const providerRoute = screen.getByRole('radiogroup', { name: 'providers route' });
    expect(
      within(providerRoute).getByRole('radio', { name: 'Real' }).hasAttribute('disabled'),
    ).toBe(true);
  });
});
