import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import * as pty from 'node-pty';
import { z } from 'zod';
import { WorkspaceJail } from './fs.js';

export const RunCommandInput = z.object({
  command: z.string().min(1),
  cwd: z.string().default('.'),
  timeoutMs: z.number().int().min(100).max(600_000).default(120_000),
  byteCap: z.number().int().min(1024).max(50_000_000).default(1_000_000),
  env: z.record(z.string(), z.string()).default({}),
  pty: z.boolean().default(true),
});
export interface OutputEvent {
  type: 'stdout' | 'stderr';
  data: string;
}
export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  spillFile?: string;
  timedOut: boolean;
}
const envAllow = new Set([
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'TEMP',
  'TMP',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'LANG',
  'TERM',
]);
function ignoreOutput(_event: OutputEvent): void {
  /* optional streaming callback */
}
export async function runCommand(
  jail: WorkspaceJail,
  raw: unknown,
  onOutput: (event: OutputEvent) => void = ignoreOutput,
  signal?: AbortSignal,
): Promise<CommandResult> {
  if (signal?.aborted) throw abortReason(signal);
  const input = RunCommandInput.parse(raw);
  const cwd = await jail.resolve(input.cwd);
  if (signal?.aborted) throw abortReason(signal);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined && envAllow.has(key.toUpperCase())) env[key] = value;
  for (const [key, value] of Object.entries(input.env)) env[key] = value;
  const shell = chooseShell(env, input.env.FERRY_SHELL ?? process.env.FERRY_SHELL);
  const chunks: { out: Buffer[]; err: Buffer[] } = { out: [], err: [] };
  let bytes = 0;
  let spillFile: string | undefined;
  let timedOut = false;
  const write = async (type: 'stdout' | 'stderr', value: string | Buffer): Promise<void> => {
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
    onOutput({ type, data: buffer.toString('utf8') });
    const target = type === 'stdout' ? chunks.out : chunks.err;
    if (bytes < input.byteCap) {
      const accepted = buffer.subarray(0, input.byteCap - bytes);
      target.push(accepted);
      bytes += accepted.length;
      if (accepted.length < buffer.length) await spill(buffer.subarray(accepted.length));
    } else await spill(buffer);
  };
  const spill = async (buffer: Buffer): Promise<void> => {
    spillFile ??= path.join(
      os.tmpdir(),
      `ferry-command-${String(process.pid)}-${String(Date.now())}.log`,
    );
    await fs.appendFile(spillFile, buffer);
  };
  let exitCode: number | null = null;
  const canPty = input.pty && process.platform === 'win32';
  if (canPty) {
    try {
      const child = pty.spawn(shell.file, [...shell.args(input.command)], {
        cwd,
        env,
        cols: 120,
        rows: 32,
        useConpty: true,
      });
      const timeout = setTimeout(() => {
        timedOut = true;
        killTree(child.pid, env, () => {
          child.kill();
        });
      }, input.timeoutMs);
      await new Promise<void>((resolve) => {
        const abort = () => {
          killTree(child.pid, env, () => {
            child.kill();
          });
        };
        signal?.addEventListener('abort', abort, { once: true });
        child.onData((data) => {
          void write('stdout', data);
        });
        child.onExit(({ exitCode: code }) => {
          exitCode = code;
          clearTimeout(timeout);
          signal?.removeEventListener('abort', abort);
          resolve();
        });
      });
      if (signal?.aborted) throw abortReason(signal);
    } catch {
      if (signal?.aborted) throw abortReason(signal);
      exitCode = await fallback();
    }
  } else exitCode = await fallback();
  return {
    exitCode,
    stdout: Buffer.concat(chunks.out).toString('utf8'),
    stderr: Buffer.concat(chunks.err).toString('utf8'),
    ...(spillFile ? { spillFile } : {}),
    timedOut,
  };

  async function fallback(): Promise<number> {
    const child = execa(shell.file, shell.args(input.command), {
      cwd,
      env,
      extendEnv: false,
      reject: false,
      windowsHide: true,
      buffer: false,
      ...(process.platform === 'win32' ? {} : { detached: true }),
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      killTree(child.pid, env, () => {
        child.kill('SIGKILL');
      });
    }, input.timeoutMs);
    const abort = () => {
      killTree(child.pid, env, () => {
        child.kill('SIGKILL');
      });
    };
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (data: Buffer) => {
      void write('stdout', data);
    });
    child.stderr.on('data', (data: Buffer) => {
      void write('stderr', data);
    });
    const result = await child;
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
    if (signal?.aborted) throw abortReason(signal);
    return result.exitCode ?? 1;
  }
}
function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError');
}
function killTree(
  pid: number | undefined,
  env: Record<string, string>,
  fallback: () => void,
): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    void execa('taskkill', ['/PID', String(pid), '/T', '/F'], {
      reject: false,
      windowsHide: true,
      env,
      extendEnv: false,
    })
      .then((result) => {
        if (result.failed) fallback();
      })
      .catch(() => {
        fallback();
      });
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      fallback();
    }
  }
}
function chooseShell(
  env: Record<string, string>,
  configuredShell?: string,
): {
  file: string;
  args: (command: string) => string[];
} {
  if (process.platform === 'win32') {
    if (configuredShell) {
      const configured = findOnPath(configuredShell, env.PATH) ?? configuredShell;
      return { file: configured, args: (command) => ['-lc', command] };
    }
    const pwsh = findOnPath('pwsh.exe', env.PATH);
    if (pwsh)
      return { file: pwsh, args: (command) => ['-NoLogo', '-NoProfile', '-Command', command] };
    const powershell = env.SYSTEMROOT
      ? path.join(env.SYSTEMROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : 'powershell.exe';
    if (existsSync(powershell))
      return {
        file: powershell,
        args: (command) => ['-NoLogo', '-NoProfile', '-Command', command],
      };
    const cmd = env.COMSPEC ?? 'cmd.exe';
    return { file: cmd, args: (command) => ['/d', '/s', '/c', command] };
  }
  return { file: env.SHELL ?? '/bin/bash', args: (command) => ['-lc', command] };
}
function findOnPath(file: string, pathValue = ''): string | undefined {
  return pathValue
    .split(path.delimiter)
    .map((dir) => path.join(dir, file))
    .find((candidate) => {
      try {
        return requireExists(candidate);
      } catch {
        return false;
      }
    });
}
function requireExists(file: string): boolean {
  return existsSync(file);
}
