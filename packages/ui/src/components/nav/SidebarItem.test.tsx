// @vitest-environment jsdom
import { Lightbulb } from 'lucide-react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SidebarItem } from './index';
describe('SidebarItem', () => {
  it('supports active state and a separate menu action', () => {
    const action = vi.fn();
    render(<SidebarItem active icon={Lightbulb} label="Best Available" onClick={action} />);
    expect(
      screen.getByRole('button', { name: 'Best Available' }).getAttribute('aria-current'),
    ).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Best Available' }));
    expect(action).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'More actions for Best Available' })).toBeTruthy();
  });
});
