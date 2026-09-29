import { afterEach, describe, expect, it, vi } from 'vitest';
import { killDetachedProcessGroup } from '../src/command.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('detached process group termination', () => {
  it.each([undefined, 0, 1, process.pid, 42])(
    'does not signal an invalid, own, or non-detached PID (%s)',
    (pid) => {
      const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
      const fallback = vi.fn();

      killDetachedProcessGroup(pid, pid === 42 ? false : true, fallback);

      expect(kill).not.toHaveBeenCalled();
      expect(fallback).toHaveBeenCalledOnce();
    },
  );

  it('signals only the group belonging to a valid detached child', () => {
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const fallback = vi.fn();
    const childPid = process.pid + 1;

    killDetachedProcessGroup(childPid, true, fallback);

    expect(kill).toHaveBeenCalledWith(-childPid, 'SIGKILL');
    expect(fallback).not.toHaveBeenCalled();
  });
});
