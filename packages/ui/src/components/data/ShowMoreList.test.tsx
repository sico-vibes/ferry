// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ShowMoreList } from './ShowMoreList';

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

describe('ShowMoreList', () => {
  it('shows more items, collapses, and remembers the group for the session', () => {
    const items = Array.from({ length: 14 }, (_, index) => `Item ${String(index + 1)}`);
    const view = render(
      <ShowMoreList
        items={items}
        groupKey="test-group"
        renderItem={(item) => <li key={item}>{item}</li>}
      />,
    );
    expect(screen.getAllByRole('listitem')).toHaveLength(6);
    fireEvent.click(screen.getByRole('button', { name: 'Show more items (8)' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(12);
    fireEvent.click(screen.getByRole('button', { name: 'Show less' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(6);
    fireEvent.click(screen.getByRole('button', { name: 'Show more items (8)' }));
    view.unmount();
    render(
      <ShowMoreList
        items={items}
        groupKey="test-group"
        renderItem={(item) => <li key={item}>{item}</li>}
      />,
    );
    expect(screen.getAllByRole('listitem')).toHaveLength(12);
  });

  it('keeps each expanded window at or below 100 rows', () => {
    const items = Array.from({ length: 240 }, (_, index) => `Row ${String(index + 1)}`);
    render(
      <ShowMoreList
        items={items}
        groupKey="large-test-group"
        renderItem={(item) => <li key={item}>{item}</li>}
      />,
    );
    for (let index = 0; index < 20; index += 1) {
      const showMore = screen.queryByRole('button', { name: /Show more items/ });
      if (!showMore || screen.getAllByRole('listitem').length >= 100) break;
      fireEvent.click(showMore);
    }
    expect(screen.getAllByRole('listitem')).toHaveLength(100);
    fireEvent.click(screen.getByRole('button', { name: /Show more items/ }));
    expect(screen.getAllByRole('listitem')).toHaveLength(6);
    expect(screen.getByText('Row 101')).toBeTruthy();
    expect(screen.queryByText('Row 1')).toBeNull();
  });
});
