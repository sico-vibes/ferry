// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EffortChip } from './EffortChip';

afterEach(() => {
  cleanup();
});

describe('EffortChip', () => {
  it('is hidden when the model has no effort control', () => {
    render(<EffortChip efforts={undefined} value={null} onChange={vi.fn()} />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('offers only the levels the model supports and clears back to Default', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<EffortChip efforts={['low', 'high']} value="high" onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: 'Reasoning effort: High' }));
    expect(screen.getByRole('menuitem', { name: 'Low' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Medium' })).toBeNull();
    await user.click(screen.getByRole('menuitem', { name: 'Default' }));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('shows a level the new model does not offer as Default', () => {
    render(<EffortChip efforts={['low']} value="max" onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Reasoning effort: Default' })).toBeTruthy();
  });
});
