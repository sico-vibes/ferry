import { afterEach, describe, expect, it, vi } from 'vitest';
import { killDetachedProcessGroup, sanitizeCommandEnvironment } from '../src/command.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('command environment sanitizing', () => {
  it('canonicalizes Windows allow-listed keys and drops everything else', () => {
    const env = sanitizeCommandEnvironment(
      {
        Path: 'C:\\bin',
        SystemRoot: 'C:\\Windows',
        ComSpec: 'C:\\Windows\\system32\\cmd.exe',
        PATHEXT: '.EXE',
        TEMP: 'C:\\Temp',
        FERRY_SECRET: 'must-not-be-forwarded',
        SomeUserToken: 'also-not-forwarded',
      },
      {},
      'win32',
    );
    expect(env).toEqual({
      PATH: 'C:\\bin',
      SYSTEMROOT: 'C:\\Windows',
      COMSPEC: 'C:\\Windows\\system32\\cmd.exe',
      PATHEXT: '.EXE',
      TEMP: 'C:\\Temp',
    });
  });

  it('folds Windows override collisions into the existing key without leaking secrets', () => {
    const env = sanitizeCommandEnvironment(
      { Path: 'C:\\bin', HOME: 'C:\\Users\\u', FERRY_SECRET: 'nope' },
      { home: 'D:\\other', CustomFlag: 'on' },
      'win32',
    );
    expect(env).toEqual({
      PATH: 'C:\\bin',
      HOME: 'D:\\other',
      CustomFlag: 'on',
    });
    expect(Object.keys(env).filter((key) => key.toUpperCase() === 'HOME')).toHaveLength(1);
  });

  it('preserves POSIX key case while still filtering to the allow list', () => {
    const env = sanitizeCommandEnvironment(
      { PATH: '/usr/bin', Home: '/home/u', FERRY_SECRET: 'nope' },
      { home: '/tmp/u' },
      'linux',
    );
    expect(env).toEqual({ PATH: '/usr/bin', Home: '/home/u', home: '/tmp/u' });
  });
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
