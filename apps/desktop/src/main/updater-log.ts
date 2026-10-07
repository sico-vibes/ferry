import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { inspect } from 'node:util';

export function createUpdaterLogger(file: string, maxBytes = 1024 * 1024) {
  const write = (level: string, args: unknown[]): void => {
    try {
      mkdirSync(dirname(file), { recursive: true });
      const line = `${new Date().toISOString()} ${level} ${args.map((arg) => (typeof arg === 'string' ? arg : inspect(arg))).join(' ')}\n`;
      let size = 0;
      try {
        size = statSync(file).size;
      } catch {
        /* First log entry. */
      }
      if (size + Buffer.byteLength(line) > maxBytes) {
        rmSync(`${file}.1`, { force: true });
        if (size) renameSync(file, `${file}.1`);
      }
      appendFileSync(file, Buffer.from(line).subarray(0, maxBytes));
    } catch {
      /* Logging must not prevent update recovery. */
    }
  };
  return {
    info: (...args: unknown[]) => {
      write('INFO', args);
    },
    warn: (...args: unknown[]) => {
      write('WARN', args);
    },
    error: (...args: unknown[]) => {
      write('ERROR', args);
    },
    debug: (...args: unknown[]) => {
      write('DEBUG', args);
    },
  };
}
