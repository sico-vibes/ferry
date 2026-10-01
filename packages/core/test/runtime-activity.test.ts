import { afterEach, describe, expect, it } from 'vitest';
import {
  isCoreWindowActive,
  onCoreWindowActiveChange,
  setCoreWindowActive,
} from '../src/runtime-activity.js';

describe('core window activity', () => {
  afterEach(() => {
    setCoreWindowActive(true);
  });

  it('notifies listeners only when active state changes', () => {
    const changes: boolean[] = [];
    const unsubscribe = onCoreWindowActiveChange((active) => changes.push(active));

    setCoreWindowActive(false);
    setCoreWindowActive(false);
    setCoreWindowActive(true);
    unsubscribe();
    setCoreWindowActive(false);

    expect(changes).toEqual([false, true]);
    expect(isCoreWindowActive()).toBe(false);
  });
});
