import { openSync, closeSync } from 'node:fs';
import { ReadStream, WriteStream } from 'node:tty';

/**
 * Windows console devices. The installed CLI runs inside Ferry.exe (a GUI-subsystem binary with
 * ELECTRON_RUN_AS_NODE=1): its stdout reaches the console but stdin is not a TTY, so Ink needs the
 * console input opened directly.
 */
export const CONSOLE_INPUT = '\\\\.\\CONIN$';
export const CONSOLE_OUTPUT = '\\\\.\\CONOUT$';

export interface TerminalStreams {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  dispose(): void;
}

export function selectTerminalStreams(
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout,
  platform: NodeJS.Platform = process.platform,
): TerminalStreams | undefined {
  let stdin = input;
  let stdout = output;
  const opened: number[] = [];
  if (platform === 'win32' && !stdin.isTTY) {
    try {
      // Device path: plain 'CONIN$' is resolved by Node as a file in the current folder.
      const fd = openSync(CONSOLE_INPUT, 'r+');
      opened.push(fd);
      const stream = new ReadStream(fd);
      if (!stream.isTTY) throw new Error('Console input is not a TTY');
      stdin = stream;
    } catch {
      for (const fd of opened) closeSync(fd);
      return undefined;
    }
  }
  if (platform === 'win32' && !stdout.isTTY) {
    try {
      const fd = openSync(CONSOLE_OUTPUT, 'r+');
      opened.push(fd);
      const stream = new WriteStream(fd);
      if (!stream.isTTY) throw new Error('Console output is not a TTY');
      stdout = stream;
    } catch {
      for (const fd of opened) closeSync(fd);
      return undefined;
    }
  }
  if (!stdin.isTTY || !stdout.isTTY) {
    for (const fd of opened) closeSync(fd);
    return undefined;
  }
  return {
    stdin,
    stdout,
    dispose() {
      for (const fd of opened) closeSync(fd);
    },
  };
}
