// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MiniAdd } from './index';
describe('MiniAdd', () => {
  it('has an accessible label and calls its action', () => {
    const action = vi.fn();
    render(<MiniAdd label="Add profile" onClick={action} />);
    const button = screen.getByRole('button', { name: 'Add profile' });
    expect(button.className).toContain('size-7');
    fireEvent.click(button);
    expect(action).toHaveBeenCalledOnce();
  });
});
