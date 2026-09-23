// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { UsageChart } from './UsageChart';
describe('UsageChart', () => {
  it('labels the selected metric and period', () => {
    render(<UsageChart data={[]} providerNames={{}} metric="tokens" />);
    expect(
      screen.getByRole('img', { name: '14 day stacked tokens usage by provider' }),
    ).toBeTruthy();
  });
});
