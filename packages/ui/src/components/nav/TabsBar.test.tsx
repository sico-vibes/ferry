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
});
