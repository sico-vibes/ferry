// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CapacityCard } from './index';
afterEach(cleanup);
describe('CapacityCard', () => {
  it('opens the breakdown on card activation', () => {
    const action = vi.fn();
    render(<CapacityCard stepsLeft={420} percent={64} onOpenBreakdown={action} />);
    fireEvent.click(screen.getByRole('button', { name: /420 steps left/ }));
    expect(action).toHaveBeenCalledOnce();
  });
  it('routes Add provider to its own action', () => {
    const action = vi.fn();
    render(<CapacityCard stepsLeft={420} percent={64} onAddProvider={action} />);
    fireEvent.click(screen.getByRole('button', { name: /Add provider/ }));
    expect(action).toHaveBeenCalledOnce();
  });
});
