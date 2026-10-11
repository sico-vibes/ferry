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
  const ownedStreams: (ReadStream | WriteStream)[] = [];
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    // closeSync alone leaves the TTY's libuv read handle alive in Electron's GUI runtime.
    for (const stream of ownedStreams) {
      if (stream instanceof ReadStream) {
        if (stream.isRaw) stream.setRawMode(false);
        stream.pause();
      }
      stream.unref();
      stream.destroy();
    }
    for (const fd of opened) closeSync(fd);
  };
  if (platform === 'win32' && !stdin.isTTY) {
    try {
      // Device path: plain 'CONIN$' is resolved by Node as a file in the current folder.
      const fd = openSync(CONSOLE_INPUT, 'r+');
      opened.push(fd);
      const stream = new ReadStream(fd);
      ownedStreams.push(stream);
      opened.pop(); // The stream now owns and closes this descriptor.
      if (!stream.isTTY) throw new Error('Console input is not a TTY');
      stdin = stream;
    } catch {
      dispose();
      return undefined;
    }
  }
  if (platform === 'win32' && !stdout.isTTY) {
    try {
      const fd = openSync(CONSOLE_OUTPUT, 'r+');
      opened.push(fd);
      const stream = new WriteStream(fd);
      ownedStreams.push(stream);
      opened.pop();
      if (!stream.isTTY) throw new Error('Console output is not a TTY');
      stdout = stream;
    } catch {
      dispose();
      return undefined;
    }
  }
  if (!stdin.isTTY || !stdout.isTTY) {
    dispose();
    return undefined;
  }
  return {
    stdin,
    stdout,
    dispose,
  };
}
