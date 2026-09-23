// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TopRightCluster } from './index';
describe('TopRightCluster', () => {
  it('invokes configuration and share actions', () => {
    const config = vi.fn();
    const share = vi.fn();
    render(<TopRightCluster onConfiguration={config} onShare={share} />);
    fireEvent.click(screen.getByRole('button', { name: /Configuration/ }));
    fireEvent.click(screen.getByRole('button', { name: /Share/ }));
    expect(config).toHaveBeenCalledOnce();
    expect(share).toHaveBeenCalledOnce();
  });
});
