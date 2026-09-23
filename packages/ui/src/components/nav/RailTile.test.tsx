// @vitest-environment jsdom
import { MessagesSquare } from 'lucide-react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RailTile } from './index';
describe('RailTile', () => {
  it('marks the active route', () => {
    render(<RailTile active icon={MessagesSquare} label="Chats" />);
    const button = screen.getByRole('button', { name: 'Chats' });
    expect(button.getAttribute('aria-current')).toBe('page');
    expect(button.className).toContain('text-[10.5px]');
  });
});
