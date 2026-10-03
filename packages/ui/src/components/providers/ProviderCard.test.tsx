// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Provider } from '@ferry/shared';
import { ProviderCard } from './ProviderCard';
const provider: Provider = {
  id: 'gemini' as Provider['id'],
  name: 'Gemini API',
  tag: 'legit',
  kind: 'api',
  brand: null,
  keyStatus: 'missing',
  enabled: true,
  health: 'ok',
  cooldownUntil: null,
  dataUse: null,
  termsNote: null,
  signupUrl: null,
  docsUrl: null,
  verifiedAt: null,
  modelCount: 0,
  windows: [],
  stepsLeftToday: 8,
};
describe('ProviderCard', () => {
  it('exposes provider key status and actions', () => {
    render(<ProviderCard provider={provider} onTest={vi.fn()} onManageKey={vi.fn()} />);
    expect(screen.getByText('Available')).toBeTruthy();
    expect(screen.getByText('Key missing')).toBeTruthy();
    expect(screen.getByText('Free')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Test Gemini API' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Manage provider' })).toBeTruthy();
  });

  it('shows routing badges only for non-default preferences', () => {
    render(<ProviderCard provider={provider} priority={2} weight={3} />);
    expect(screen.getByText('Priority 2')).toBeTruthy();
    expect(screen.getByText('Weight 3')).toBeTruthy();
    expect(screen.queryByText('Priority 0')).toBeNull();
    expect(screen.queryByText('Weight 1')).toBeNull();
  });

  it('describes providers without a daily step cap', () => {
    render(<ProviderCard provider={{ ...provider, stepsLeftToday: null }} />);
    const footer = screen.getByText('No daily cap').closest('footer');
    expect(footer).toBeTruthy();
    expect(footer?.querySelector('.provider-card-footer-actions')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Test Gemini API' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Manage key' })).toBeTruthy();
    expect(screen.queryByText('Rate limited, no daily cap')).toBeNull();
  });

  it('explains terminal authentication health and points to key recovery', () => {
    render(<ProviderCard provider={{ ...provider, health: 'auth_invalid' }} />);
    expect(screen.getByText('Needs attention')).toBeTruthy();
    expect(screen.getByText('Needs attention: enter the key again')).toBeTruthy();
  });

  it('shows honest training and temporary-promotion labels on provider cards', () => {
    render(
      <ProviderCard
        provider={{
          ...provider,
          tag: 'promo',
          dataUse: 'Auto Free may route prompts to providers that use them to improve services.',
        }}
      />,
    );
    expect(screen.getByText('May train on your prompts')).toBeTruthy();
    expect(screen.getByText(/providers that use them to improve services/i)).toBeTruthy();
    expect(screen.getByText('Promotional access may end without notice.')).toBeTruthy();
  });
});
