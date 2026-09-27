// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TagBadge } from './TagBadge';
describe('TagBadge', () => {
  it('shows the provider category label', () => {
    render(<TagBadge kind="promo" />);
    expect(screen.getByText('Promo')).toBeTruthy();
    expect(screen.getByTitle('Promotional — may end without notice')).toBeTruthy();
  });

  it('labels trials distinctly', () => {
    render(<TagBadge kind="trial" />);
    expect(screen.getByText('Trial')).toBeTruthy();
  });
});
