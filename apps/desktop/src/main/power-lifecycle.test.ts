import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { attachPowerLifecycle } from './power-lifecycle.js';

it('simulates repeated sleep/wake and detaches lifecycle handlers on quit', () => {
  const monitor = new EventEmitter();
  const suspend = vi.fn(),
    resume = vi.fn();
  const detach = attachPowerLifecycle(monitor, { suspend, resume });
  for (let index = 0; index < 3; index++) {
    monitor.emit('suspend');
    monitor.emit('resume');
  }
  expect(suspend).toHaveBeenCalledTimes(3);
  expect(resume).toHaveBeenCalledTimes(3);
  detach();
  monitor.emit('resume');
  expect(resume).toHaveBeenCalledTimes(3);
  expect(monitor.listenerCount('suspend')).toBe(0);
});
