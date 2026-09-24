import { beforeEach, describe, expect, it } from 'vitest';
import { useToasts } from './toasts';

beforeEach(() => {
  useToasts.setState({ items: [] });
});

describe('toast store', () => {
  it('deduplicates identical toasts by their default key', () => {
    useToasts.getState().push({ kind: 'info', title: 'Saved', body: null });
    useToasts.getState().push({ kind: 'info', title: 'Saved', body: null });
    expect(useToasts.getState().items).toHaveLength(1);
  });

  it('replaces a keyed toast while keeping its id', () => {
    useToasts.getState().push({ kind: 'info', title: 'Delegation running', body: 'impl' }, 'd1');
    const firstId = useToasts.getState().items[0]?.id;
    useToasts
      .getState()
      .push({ kind: 'success', title: 'Delegation completed', body: 'impl' }, 'd1');
    const items = useToasts.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe('success');
    expect(items[0]?.id).toBe(firstId);
  });

  it('keeps only the four most recent toasts', () => {
    for (let index = 0; index < 6; index += 1) {
      useToasts.getState().push({ kind: 'info', title: `Toast ${String(index)}`, body: null });
    }
    expect(useToasts.getState().items).toHaveLength(4);
    expect(useToasts.getState().items.map((toast) => toast.title)).toEqual([
      'Toast 2',
      'Toast 3',
      'Toast 4',
      'Toast 5',
    ]);
  });

  it('dismisses a toast by id', () => {
    useToasts.getState().push({ kind: 'info', title: 'One', body: null });
    useToasts.getState().push({ kind: 'info', title: 'Two', body: null });
    const id = useToasts.getState().items[0]?.id;
    if (id === undefined) throw new Error('Expected a toast id');
    useToasts.getState().dismiss(id);
    expect(useToasts.getState().items.map((toast) => toast.title)).toEqual(['Two']);
  });
});
