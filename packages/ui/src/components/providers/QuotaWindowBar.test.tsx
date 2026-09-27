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
  it('renders unknown limits without implying a cap', () => {
    render(<QuotaWindowBar window={base} />);
    expect(screen.getByText('—')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Limit unknown' })).toBeTruthy();
  });
});
