// @vitest-environment jsdom
import { FileText, FolderGit2 } from 'lucide-react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TabsBar } from './index';
describe('TabsBar', () => {
  it('selects tabs and moves focus with arrow keys', () => {
    const action = vi.fn();
    render(
      <TabsBar
        activeId="one"
        onSelect={action}
        tabs={[
          { id: 'one', label: 'One', icon: FileText },
          { id: 'two', label: 'Two', icon: FolderGit2 },
        ]}
      />,
    );
    const one = screen.getByRole('tab', { name: 'One' });
    one.focus();
    fireEvent.keyDown(one, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Two' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Two' }));
    expect(action).toHaveBeenCalledWith('two');
  });

  it('maps running, approval, and error states to semantic dots', () => {
    render(
      <TabsBar
        activeId="run"
        tabs={[
          { id: 'run', label: 'Running', icon: FileText, status: 'running' },
          { id: 'approval', label: 'Approval', icon: FileText, status: 'awaiting_approval' },
          { id: 'error', label: 'Error', icon: FileText, status: 'error' },
          { id: 'idle', label: 'Idle', icon: FileText, status: 'idle' },
        ]}
      />,
    );
    expect(screen.getByRole('img', { name: 'running' }).className).toContain('bg-blue-500');
    expect(screen.getByRole('img', { name: 'Awaiting approval' }).className).toContain('bg-warn');
    expect(screen.getByRole('img', { name: 'error' }).className).toContain('bg-danger');
    expect(screen.queryByRole('img', { name: 'idle' })).toBeNull();
  });
});
