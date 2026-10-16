import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import * as pty from 'node-pty';
import { z } from 'zod';
import { WorkspaceJail } from './fs.js';
import { isShellAffectingEnvironmentKey } from './permissions.js';

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
/**
 * Copies the allow-listed parent environment variables and applies overrides.
 * Windows exposes environment variables in the case the OS stored them
 * (`Path`, `SystemRoot`, `ComSpec`), but `process.env[key]` is only
 * case-insensitive through Node's proxy — a plain object copy is
 * case-sensitive. Normalizing the Windows allow-listed keys keeps
 * `env.PATH`/`env.SYSTEMROOT`/`env.COMSPEC` lookups correct regardless of how
 * the surrounding launcher cased the environment block. POSIX keeps its
 * case-sensitive semantics. Overrides that collide with a stored Windows key
 * are folded into the existing key so a lowercase override cannot coexist
 * ambiguously with `PATH`/`HOME`.
 */
export function sanitizeCommandEnvironment(
  parent: NodeJS.ProcessEnv,
  overrides: Record<string, string> = {},
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const windows = platform === 'win32';
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    if (!envAllow.has(key.toUpperCase())) continue;
    env[windows ? key.toUpperCase() : key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (!windows) {
      env[key] = value;
      continue;
    }
    const canonical = key.toUpperCase();
    const existing = Object.keys(env).find((stored) => stored.toUpperCase() === canonical);
    env[existing ?? key] = value;
  }
  return env;
}
const WINDOWS_TREE_KILL_BUDGET_MS = 8_000;
const TREE_KILL_POLL_MS = 100;
const DIRECT_KILL_GRACE_MS = 1_000;
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
function treeCleanupError(pid: number | undefined): Error {
  return new Error(
    `run_command could not confirm the command process tree (pid ${String(pid)}) was terminated`,
  );
}
function abortCleanupError(pid: number | undefined): Error {
  return new Error(
    `run_command was aborted; its process tree (pid ${String(pid)}) could not be terminated`,
  );
}
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
  const blockedEnvironmentKey = Object.keys(input.env).find(isShellAffectingEnvironmentKey);
  if (blockedEnvironmentKey)
    throw new Error(
      `Shell-affecting environment override is not allowed: ${blockedEnvironmentKey}`,
    );
  const cwd = await jail.resolve(input.cwd);
  if (signal?.aborted) throw abortReason(signal);
  const env = sanitizeCommandEnvironment(process.env, input.env);
  const shell = chooseShell(env);
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
    let maybeChild: pty.IPty | undefined;
    try {
      maybeChild = pty.spawn(shell.file, [...shell.args(input.command)], {
        cwd,
        env,
        cols: 120,
        rows: 32,
        useConpty: true,
      });
    } catch {
      maybeChild = undefined;
    }
    if (maybeChild) {
      const child = maybeChild;
      let termination: Promise<boolean> | undefined;
      const requestTermination = (): Promise<boolean> =>
        (termination ??= killTree(child.pid, false, env, () => {
          child.kill();
        }));
      let timeout: NodeJS.Timeout | undefined;
      let abort: (() => void) | undefined;
      let dataSubscription: pty.IDisposable | undefined;
      let exitSubscription: pty.IDisposable | undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const settle = (settleFn: () => void) => {
            if (settled) return;
            settled = true;
            if (timeout) clearTimeout(timeout);
            if (abort) signal?.removeEventListener('abort', abort);
            dataSubscription?.dispose();
            exitSubscription?.dispose();
            settleFn();
          };
          exitSubscription = child.onExit(({ exitCode: code }) => {
            exitCode = code;
            if (!termination) {
              settle(resolve);
              return;
            }
            void termination.then((terminated) => {
              if (terminated) settle(resolve);
              else
                settle(() => {
                  reject(treeCleanupError(child.pid));
                });
            });
          });
          dataSubscription = child.onData((data) => {
            void write('stdout', data);
          });
          timeout = setTimeout(() => {
            if (settled) return;
            timedOut = true;
            void requestTermination().then((terminated) => {
              // A confirmed whole-tree termination is enough to report the
              // timeout even when node-pty never delivers onExit; an
              // unconfirmed tree is surfaced as a cleanup failure instead.
              if (terminated) settle(resolve);
              else
                settle(() => {
                  reject(treeCleanupError(child.pid));
                });
            });
          }, input.timeoutMs);
          abort = () => {
            const activeSignal = signal;
            if (!activeSignal) return;
            void requestTermination().then((terminated) => {
              if (terminated)
                settle(() => {
                  reject(abortReason(activeSignal));
                });
              else
                settle(() => {
                  reject(abortCleanupError(child.pid));
                });
            });
          };
          signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) abort();
        });
      } finally {
        if (timeout) clearTimeout(timeout);
        if (abort) signal?.removeEventListener('abort', abort);
        dataSubscription?.dispose();
        exitSubscription?.dispose();
      }
      if (signal?.aborted) throw abortReason(signal);
    } else {
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
    const detached = process.platform !== 'win32';
    const child = execa(shell.file, shell.args(input.command), {
      cwd,
      env,
      extendEnv: false,
      reject: false,
      windowsHide: true,
      buffer: false,
      detached,
    });
    let termination: Promise<boolean> | undefined;
    // A descendant inherits the stdout/stderr pipes, so execa only resolves
    // once those pipes close. After attempting a whole-tree kill we release our
    // read ends; if the tree could not be confirmed terminated we surface that
    // as a cleanup failure instead of waiting on a surviving descendant.
    const requestTermination = (): Promise<boolean> =>
      (termination ??= (async () => {
        const terminated = await killTree(child.pid, detached, env, () => {
          child.kill('SIGKILL');
        });
        child.stdout.destroy();
        child.stderr.destroy();
        return terminated;
      })());
    let timeout: NodeJS.Timeout | undefined;
    let abort: (() => void) | undefined;
    child.stdout.on('data', (data: Buffer) => {
      void write('stdout', data);
    });
    child.stderr.on('data', (data: Buffer) => {
      void write('stderr', data);
    });
    try {
      return await new Promise<number>((resolve, reject) => {
        let settled = false;
        const settle = (settleFn: () => void) => {
          if (settled) return;
          settled = true;
          if (timeout) clearTimeout(timeout);
          if (abort) signal?.removeEventListener('abort', abort);
          settleFn();
        };
        const normalExit = child.then((result) => result.exitCode ?? 1);
        void normalExit.then((code) => {
          if (!termination) {
            settle(() => {
              resolve(code);
            });
            return;
          }
          void termination.then((terminated) => {
            if (terminated)
              settle(() => {
                resolve(code);
              });
            else
              settle(() => {
                reject(treeCleanupError(child.pid));
              });
          });
        });
        timeout = setTimeout(() => {
          if (settled) return;
          timedOut = true;
          void requestTermination().then((terminated) => {
            if (!terminated)
              settle(() => {
                reject(treeCleanupError(child.pid));
              });
          });
        }, input.timeoutMs);
        abort = () => {
          const activeSignal = signal;
          if (!activeSignal) return;
          void requestTermination().then((terminated) => {
            if (terminated)
              settle(() => {
                reject(abortReason(activeSignal));
              });
            else
              settle(() => {
                reject(abortCleanupError(child.pid));
              });
          });
        };
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
    } finally {
      if (timeout) clearTimeout(timeout);
      if (abort) signal?.removeEventListener('abort', abort);
    }
  }
}
function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError');
}
async function killTree(
  pid: number | undefined,
  detached: boolean,
  env: Record<string, string>,
  fallback: () => void,
): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid === undefined || pid <= 1 || pid === process.pid) {
    fallback();
    return true;
  }
  if (process.platform === 'win32') {
    if (await killWindowsProcessTree(pid, env)) return true;
    // taskkill could not confirm the whole tree died; kill the process we own
    // and report the unverified tree so callers surface a cleanup failure.
    fallback();
    return false;
  }
  killDetachedProcessGroup(pid, detached, fallback);
  if (!isProcessAlive(pid)) return true;
  const deadline = Date.now() + DIRECT_KILL_GRACE_MS;
  while (isProcessAlive(pid) && Date.now() < deadline) await sleep(TREE_KILL_POLL_MS);
  return !isProcessAlive(pid);
}

/**
 * Terminates the owned Windows process tree, descendants before the root, and
 * only reports success when taskkill confirmed it (`exitCode 0`) and the owned
 * root is gone. A single taskkill can be cut short by its own budget or lose a
 * race with a freshly spawned descendant under load, so retry within a bounded
 * budget instead of silently falling back to killing only the root.
 */
async function killWindowsProcessTree(pid: number, env: Record<string, string>): Promise<boolean> {
  const taskkill = env.SYSTEMROOT
    ? path.join(env.SYSTEMROOT, 'System32', 'taskkill.exe')
    : 'taskkill.exe';
  const deadline = Date.now() + WINDOWS_TREE_KILL_BUDGET_MS;
  let confirmed = false;
  while (Date.now() < deadline) {
    let exitCode: number | null;
    try {
      exitCode =
        (
          await execa(taskkill, ['/PID', String(pid), '/T', '/F'], {
            reject: false,
            windowsHide: true,
            env,
            extendEnv: false,
            timeout: Math.max(250, deadline - Date.now()),
          })
        ).exitCode ?? null;
    } catch {
      exitCode = null;
    }
    if (exitCode === 0) confirmed = true;
    if (!isProcessAlive(pid)) return confirmed;
    await sleep(TREE_KILL_POLL_MS);
  }
  return false;
}

export function killDetachedProcessGroup(
  pid: number | undefined,
  detached: boolean,
  fallback: () => void,
): void {
  if (
    !detached ||
    !Number.isSafeInteger(pid) ||
    pid === undefined ||
    pid <= 1 ||
    pid === process.pid
  ) {
    fallback();
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    fallback();
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
