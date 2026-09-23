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
    expect(screen.getByText('Key: missing')).toBeTruthy();
    expect(screen.getByText('Free')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Test Gemini API' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Manage key' })).toBeTruthy();
  });

  it('describes providers without a daily step cap', () => {
    render(<ProviderCard provider={{ ...provider, stepsLeftToday: null }} />);
    expect(screen.getByText('Rate-limited · no daily cap')).toBeTruthy();
  });
});
