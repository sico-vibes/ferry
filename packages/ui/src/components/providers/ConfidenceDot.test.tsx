// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ConfidenceDot } from './ConfidenceDot';
describe('ConfidenceDot', () => {
  it('explains the confidence level to assistive technology', () => {
    render(<ConfidenceDot confidence="learned" />);
    expect(screen.getByRole('img', { name: 'Learned quota confidence' })).toBeTruthy();
  });
});
