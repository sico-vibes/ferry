import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  close: vi.fn(),
  raw: vi.fn(),
  pause: vi.fn(),
  readUnref: vi.fn(),
  readDestroy: vi.fn(),
  writeUnref: vi.fn(),
  writeDestroy: vi.fn(),
  inputDestroy: vi.fn(),
  outputDestroy: vi.fn(),
  failRead: false,
}));
vi.mock('node:fs', () => ({ openSync: mocks.open, closeSync: mocks.close }));
vi.mock('node:tty', () => ({
  ReadStream: class {
    constructor() {
      if (mocks.failRead) throw new Error('Console unavailable');
    }
    isTTY = true;
    isRaw = true;
    setRawMode = mocks.raw;
    pause = mocks.pause;
    unref = mocks.readUnref;
    destroy = mocks.readDestroy;
  },
  WriteStream: class {
    isTTY = true;
    unref = mocks.writeUnref;
    destroy = mocks.writeDestroy;
  },
}));
const { selectTerminalStreams } = await import('../src/terminal.js');
afterEach(() => {
  mocks.failRead = false;
  vi.clearAllMocks();
});
it('releases owned console read handles once without destroying the caller streams', () => {
  mocks.open.mockReturnValueOnce(11).mockReturnValueOnce(12);
  const input = { isTTY: false, destroy: mocks.inputDestroy } as unknown as NodeJS.ReadStream;
  const output = { isTTY: false, destroy: mocks.outputDestroy } as unknown as NodeJS.WriteStream;
  const terminal = selectTerminalStreams(input, output, 'win32');
  expect(terminal).toBeDefined();
  terminal?.dispose();
  terminal?.dispose();
  expect(mocks.raw).toHaveBeenCalledWith(false);
  expect(mocks.pause).toHaveBeenCalledOnce();
  expect(mocks.readUnref).toHaveBeenCalledOnce();
  expect(mocks.readDestroy).toHaveBeenCalledOnce();
  expect(mocks.writeDestroy).toHaveBeenCalledOnce();
  expect(mocks.close).not.toHaveBeenCalled(); // destroy owns the fd; closing twice causes EBADF.
  expect(mocks.inputDestroy).not.toHaveBeenCalled();
  expect(mocks.outputDestroy).not.toHaveBeenCalled();
});
it('closes an unclaimed descriptor when constructing the console stream fails', () => {
  mocks.open.mockReturnValueOnce(13);
  mocks.failRead = true;
  const input = { isTTY: false } as NodeJS.ReadStream;
  const output = { isTTY: true } as NodeJS.WriteStream;
  expect(selectTerminalStreams(input, output, 'win32')).toBeUndefined();
  expect(mocks.close).toHaveBeenCalledExactlyOnceWith(13);
  expect(mocks.readDestroy).not.toHaveBeenCalled();
});
