// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { VerifiedBadge } from './index';
describe('VerifiedBadge', () => {
  it('exposes its verification status', () => {
    render(<VerifiedBadge />);
    expect(screen.getByRole('img', { name: 'Verified' })).toBeTruthy();
  });
});
