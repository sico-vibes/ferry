import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, extname, join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { execa } from 'execa';

const UNSAFE_ARG = /[\0\r\n%!"`]|\$\([^)]*\)|%[^%]+%/;

/** Reject arguments that would let a CLI argument escape shell quoting on generated shims. */
export function assertSafeArguments(args: readonly string[]): void {
  for (const arg of args) {
    if (UNSAFE_ARG.test(arg)) throw new Error(`Unsafe CLI argument rejected: ${arg}`);
  }
}

export interface CommandInvocation {
  file: string;
  args: string[];
  verbatim: boolean;
}

function quoteCmdArgument(argument: string): string {
  return `"${argument.replaceAll('"', '""')}"`;
}

/**
 * Build a spawn invocation. `.cmd`/`.bat` shims on Windows must go through `cmd.exe`; every other
 * executable is spawned directly. Inline JSON cannot be passed because of the quote rejection —
 * transports write temp files instead.
 */
export function commandInvocation(executable: string, args: string[]): CommandInvocation {
  assertSafeArguments([executable, ...args]);
  const isShim =
    process.platform === 'win32' && ['.cmd', '.bat'].includes(extname(executable).toLowerCase());
  if (!isShim) return { file: executable, args, verbatim: false };
  const systemRoot = process.env.SystemRoot;
  return {
    file: systemRoot ? join(systemRoot, 'System32', 'cmd.exe') : 'cmd.exe',
    args: [
      '/d',
      '/v:off',
      '/s',
      '/c',
      `"${quoteCmdArgument(executable)} ${args.map(quoteCmdArgument).join(' ')}"`,
    ],
    verbatim: true,
  };
}

/** Resolve a CLI on PATH (including Windows shims) without shelling out. */
export async function resolveExecutable(
  command: string,
  custom: string | undefined,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  if (custom) return custom;
  if (process.platform === 'win32') {
    const searchPath =
      environment.PATH ??
      Object.entries(environment).find(([name]) => name.toLowerCase() === 'path')?.[1] ??
      '';
    for (const dir of searchPath.split(delimiter).filter(Boolean)) {
      for (const suffix of ['.cmd', '.exe', '.bat']) {
        const candidate = join(dir.replace(/^"|"$/g, ''), `${command}${suffix}`);
        try {
          await access(candidate);
          return candidate;
        } catch {
          // try the next shim / suffix
        }
      }
    }
  }
  return command;
}

export interface CliProcessExit {
  exitCode: number | null;
  failed: boolean;
  stderr: string;
}

export interface CliProcess {
  readonly pid: number | undefined;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly stdin: Writable;
  /** Resolves once the process exits; never rejects. */
  readonly exited: Promise<CliProcessExit>;
  killTree(): Promise<void>;
}

interface SpawnCliOptions {
  file: string;
  args: string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  verbatim: boolean;
  maxStderrBytes?: number;
}

/** Spawn a hidden, non-buffered CLI process with a bounded stderr capture. */
export function spawnCliProcess(options: SpawnCliOptions): CliProcess {
  const child = execa(options.file, options.args, {
    cwd: options.cwd,
    env: options.environment,
    extendEnv: false,
    reject: false,
    windowsHide: true,
    buffer: false,
    detached: process.platform !== 'win32',
    ...(options.verbatim ? { windowsVerbatimArguments: true } : {}),
  });
  // A cancelled or crashed CLI can close its pipes mid-frame; never let EPIPE crash Ferry.
  child.stdin.on('error', () => undefined);
  child.stdout.on('error', () => undefined);
  child.stderr.on('error', () => undefined);
  const limit = options.maxStderrBytes ?? 16_000;
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    if (stderr.length >= limit) return;
    stderr = `${stderr}${chunk}`.slice(0, limit);
  });
  const settled = child.then(
    (result) => ({
      exitCode: result.exitCode ?? null,
      failed: result.failed,
      stderr,
    }),
    () => ({ exitCode: null, failed: true, stderr }),
  );
  let exited = false;
  void settled.then(() => {
    exited = true;
  });
  return {
    pid: child.pid,
    stdout: child.stdout,
    stderr: child.stderr,
    stdin: child.stdin,
    exited: settled,
    async killTree(): Promise<void> {
      const pid = child.pid;
      if (process.platform === 'win32') {
        // Terminate the LIVE root's process tree first: killing the root before `taskkill /T` makes
        // the tree unenumerable, orphaning grandchildren. Never target a recycled pid.
        if (pid !== undefined && !exited) {
          let handled: boolean;
          try {
            const result = await execa('taskkill.exe', ['/pid', String(pid), '/T', '/F'], {
              reject: false,
              windowsHide: true,
              timeout: 4_000,
            });
            handled = !result.failed || isTaskkillNotFound(result.exitCode, result.stderr);
          } catch {
            handled = false;
          }
          if (!handled) child.kill('SIGKILL');
        }
      } else if (pid !== undefined) {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }
      await Promise.race([settled, delay(3_000)]);
    },
  };
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function isTaskkillNotFound(exitCode: number | undefined, output: string): boolean {
  return exitCode === 128 && /not found|no running instance/i.test(output);
}

/** Create a private per-invocation working directory. */
export async function createPrivateWorkingDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'ferry-cli-transport-'));
}

/** Remove a temp directory, tolerating transient Windows file locks. */
export async function removePrivateWorkingDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}
