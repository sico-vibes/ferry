// @vitest-environment jsdom
import { MessagesSquare } from 'lucide-react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RailTile } from './index';
describe('RailTile', () => {
  it('marks the active route', () => {
    render(<RailTile active icon={MessagesSquare} label="Chats" />);
    expect(screen.getByRole('button', { name: 'Chats' }).getAttribute('aria-current')).toBe('page');
  });
});
