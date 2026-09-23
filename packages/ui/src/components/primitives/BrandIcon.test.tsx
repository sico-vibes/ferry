// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BrandIcon } from './index';
describe('BrandIcon', () => {
  it('renders a brand icon and monogram fallback', () => {
    const { rerender } = render(<BrandIcon slug="github" label="GitHub" />);
    expect(screen.getByRole('img', { name: 'GitHub' })).toBeTruthy();
    rerender(<BrandIcon slug="openrouter" label="OpenRouter" />);
    expect(screen.getByRole('img', { name: 'OpenRouter' }).querySelector('svg')).toBeTruthy();
    rerender(<BrandIcon slug="custom" />);
    expect(screen.getByText('C')).toBeTruthy();
  });
});
