// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { IntegrationItem } from './index';
describe('IntegrationItem', () => {
  it('shows verified and disconnected integration states', () => {
    const { rerender } = render(<IntegrationItem label="GitHub" slug="github" />);
    expect(screen.getByRole('img', { name: 'Verified' })).toBeTruthy();
    rerender(<IntegrationItem label="Playwright" slug="playwright" status="disconnected" />);
    expect(screen.getByText('Playwright')).toBeTruthy();
    expect(screen.queryByRole('img', { name: 'Verified' })).not.toBeTruthy();
  });
});
