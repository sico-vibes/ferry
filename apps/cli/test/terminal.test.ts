import { describe, expect, it } from 'vitest';
import { CONSOLE_INPUT, CONSOLE_OUTPUT, selectTerminalStreams } from '../src/terminal.js';

describe('terminal stream selection', () => {
  it('keeps an existing Windows terminal', () => {
    const stdin = { isTTY: true } as NodeJS.ReadStream;
    const stdout = { isTTY: true } as NodeJS.WriteStream;
    const selected = selectTerminalStreams(stdin, stdout, 'win32');
    expect(selected?.stdin).toBe(stdin);
    expect(selected?.stdout).toBe(stdout);
  });

  it('opens the console through device paths, not file names in the current folder', () => {
    expect(CONSOLE_INPUT).toBe(String.raw`\\.\CONIN$`);
    expect(CONSOLE_OUTPUT).toBe(String.raw`\\.\CONOUT$`);
  });

  it('rejects non-interactive input outside Windows', () => {
    const stdin = { isTTY: undefined } as unknown as NodeJS.ReadStream;
    const stdout = { isTTY: true } as unknown as NodeJS.WriteStream;
    expect(selectTerminalStreams(stdin, stdout, 'linux')).toBeUndefined();
  });
});
