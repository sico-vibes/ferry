import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { OAuthProvider } from '@ferry/shared';
import { OAuthProviderRows } from './OAuthProviderRows.js';

const rows: OAuthProvider[] = [
  {
    id: 'openrouter',
    tag: 'legit',
    name: 'OpenRouter',
    subscriptionRequired: false,
    models: ['OpenRouter catalog'],
    riskLevel: 'low',
    riskText: 'Official login.',
    connected: false,
    group: 'official',
    actionAvailable: true,
  },
  {
    id: 'anthropic',
    tag: 'subscription_oauth',
    name: 'Anthropic Claude Pro/Max',
    subscriptionRequired: true,
    models: ['Claude'],
    riskLevel: 'high',
    riskText: 'Suspension risk.',
    connected: false,
    group: 'subscription',
    actionAvailable: true,
  },
  {
    id: 'radius',
    tag: 'subscription_oauth',
    name: 'Radius',
    subscriptionRequired: true,
    models: ['Radius model'],
    riskLevel: 'medium',
    riskText: 'Gateway login.',
    connected: false,
    group: 'gateway',
    actionAvailable: true,
    advanced: true,
  },
  {
    id: 'kilo',
    tag: 'subscription_oauth',
    name: 'Kilo',
    subscriptionRequired: false,
    models: [],
    riskLevel: 'low',
    riskText: 'Coming soon.',
    connected: false,
    group: 'coming_soon',
    actionAvailable: false,
    signupUrl: 'https://kilo.ai/',
  },
  {
    id: 'gemini-cli',
    tag: 'subscription_oauth',
    name: 'Gemini CLI',
    subscriptionRequired: true,
    models: [],
    riskLevel: 'high',
    riskText: 'Removed from pi-ai.',
    connected: false,
    group: 'unavailable',
    actionAvailable: false,
  },
];

describe('OAuthProviderRows', () => {
  it('groups providers into keyboard reachable rows and filters by search', async () => {
    const user = userEvent.setup();
    const onLogin = vi.fn<(provider: OAuthProvider, gateway?: string) => void>();
    render(<OAuthProviderRows onLogin={onLogin} onLogout={vi.fn()} providers={rows} />);
    await user.tab();
    expect(
      screen.getByRole('searchbox', { name: 'Filter OAuth logins' }) === document.activeElement,
    ).toBe(true);
    await user.tab();
    expect(screen.getByText('Official OAuth').closest('summary') === document.activeElement).toBe(
      true,
    );
    expect(screen.getByText('Official OAuth')).toBeTruthy();
    expect(screen.getByText('Subscription (unofficial)')).toBeTruthy();
    expect(screen.getByText('Gateways')).toBeTruthy();
    expect(screen.getByText('Coming soon', { selector: 'summary' })).toBeTruthy();
    expect(screen.getByText('Removed from pi-ai.')).toBeTruthy();
    expect(screen.getAllByText('1 model').length).toBeGreaterThan(0);
    expect(
      screen.getByRole('button', { name: 'Log in to OpenRouter' }).hasAttribute('disabled'),
    ).toBe(false);
    expect(screen.queryByRole('button', { name: 'Log in to Gemini CLI' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Log in to Kilo' })).toBeNull();
    await user.click(screen.getByText('Configure…'));
    expect(screen.getByRole('textbox', { name: 'Radius gateway URL' })).toBeTruthy();
    const radiusLogin = screen.getByRole('button', { name: 'Log in to Radius' });
    expect(radiusLogin.hasAttribute('disabled')).toBe(true);
    await user.type(
      screen.getByRole('textbox', { name: 'Radius gateway URL' }),
      'https://radius.example',
    );
    expect(radiusLogin.hasAttribute('disabled')).toBe(false);
    await user.click(radiusLogin);
    expect(onLogin).toHaveBeenCalledWith(
      rows.find((provider) => provider.id === 'radius'),
      'https://radius.example',
    );
    await user.click(screen.getByRole('button', { name: 'Log in to OpenRouter' }));
    expect(onLogin).toHaveBeenCalledWith(rows[0], undefined);
    await user.type(screen.getByRole('searchbox', { name: 'Filter OAuth logins' }), 'anthropic');
    expect(screen.getByText('Anthropic Claude Pro/Max')).toBeTruthy();
    expect(screen.queryByText('OpenRouter')).toBeNull();
  });
});
