// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SidebarSection } from './index';
describe('SidebarSection', () => {
  it('labels its section and invokes add', () => {
    const action = vi.fn();
    render(<SidebarSection label="Integrations" action={action} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add to Integrations' }));
    expect(action).toHaveBeenCalledOnce();
  });
});
