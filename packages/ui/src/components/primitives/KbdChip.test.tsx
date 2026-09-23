// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { KbdChip } from './index';
describe('KbdChip', () => {
  it('shows the shortcut text', () => {
    render(<KbdChip />);
    expect(screen.getByText('Ctrl F')).toBeTruthy();
  });
});
