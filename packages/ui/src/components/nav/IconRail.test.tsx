// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IconRail } from './index';
describe('IconRail', () => {
  it('navigates from the primary rail', () => {
    const action = vi.fn();
    render(<IconRail active="chats" onNavigate={action} />);
    fireEvent.click(screen.getByRole('button', { name: 'Library' }));
    expect(action).toHaveBeenCalledWith('library');
  });
});
