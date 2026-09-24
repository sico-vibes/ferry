// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { QuotaWindow } from '@ferry/shared';
import { QuotaWindowBar } from './QuotaWindowBar';
const base: QuotaWindow = {
  id: 'monthly',
  scope: 'provider',
  modelRef: null,
  metric: 'tokens',
  kind: 'monthly',
  periodLabel: 'per month',
  used: 820_000,
  limit: null,
  remaining: null,
  resetAt: null,
  confidence: 'unknown',
};
describe('QuotaWindowBar', () => {
  it('renders uncapped usage and confidence', () => {
    render(<QuotaWindowBar window={base} />);
    expect(screen.getByText('820K · no cap')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'No cap' })).toBeTruthy();
  });
});
