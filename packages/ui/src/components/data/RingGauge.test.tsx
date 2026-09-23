// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RingGauge } from './index';
describe('RingGauge', () => {
  it('reports the capacity accessibly and clamps its value', () => {
    render(<RingGauge value={120} />);
    expect(
      screen.getByRole('img', { name: "100% of today's free capacity remaining" }),
    ).toBeTruthy();
  });
});
