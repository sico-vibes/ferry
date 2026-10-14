import { execa, type Subprocess } from 'execa';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commandInvocation } from '../index.js';

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export interface CodexAppServerOptions {
  executable: string;
  args?: string[];
  environment: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Minimal headerless JSON-RPC 2.0 client for `codex app-server` over stdio.
 *
 * The installed app-server omits the `"jsonrpc":"2.0"` field on the wire, so responses are matched
 * by numeric `id` and unknown notifications/requests are ignored. Discovery only: no threads or
 * turns are started, and native tool/host approvals are never granted. The child runs in a private
 * temp working directory so the user's project instructions are never loaded.
 */
export class CodexAppServer {
  readonly #pending = new Map<number, PendingRequest>();
  readonly #child: Subprocess | undefined;
  #buffer = '';
  #nextId = 1;
  #closed = false;
  readonly #timeoutMs: number;
  readonly #terminate: () => Promise<void>;
  readonly #abort?: () => void;

  constructor(options: CodexAppServerOptions) {
    this.#timeoutMs = options.timeoutMs ?? 20_000;
    if (options.signal?.aborted === true) {
      // Never spawn a subprocess for an already-cancelled probe.
      this.#closed = true;
      this.#terminate = () => Promise.resolve();
      return;
    }
    const cwd = mkdtempSync(join(tmpdir(), 'ferry-codex-app-server-'));
    const invocation = commandInvocation(options.executable, options.args ?? ['app-server']);
    const child = execa(invocation.file, invocation.args, {
      env: options.environment,
      cwd,
      extendEnv: false,
      windowsHide: true,
      buffer: false,
      reject: false,
      detached: process.platform !== 'win32',
      ...(invocation.verbatim ? { windowsVerbatimArguments: true } : {}),
    });
    // execa's generic result type is not assignable to the default `Subprocess` under
    // exactOptionalPropertyTypes; the runtime shape is identical.
    this.#child = child as unknown as Subprocess;
    child.stderr.on('data', () => undefined); // May contain credentials/provider text; never log it.
    child.stdout.on('data', (chunk: Buffer | string) => {
      this.#onData(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    });
    child.stdin.on('error', () => {
      this.#failAll(new Error('Codex app-server stdin closed'));
    });
    void child
      .then(() => {
        this.#failAll(new Error('Codex app-server exited'));
      })
      .catch(() => undefined);
    this.#terminate = async () => {
      const pid = child.pid;
      if (pid !== undefined) {
        if (process.platform === 'win32')
          await execa('taskkill.exe', ['/pid', String(pid), '/T', '/F'], {
            reject: false,
            windowsHide: true,
            timeout: 3000,
          }).catch(() => undefined);
        else {
          try {
            process.kill(-pid, 'SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
        }
        await child.catch(() => undefined);
      }
      rmSync(cwd, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    };
    const signal = options.signal;
    if (signal) {
      const abort = () => {
        void this.close();
      };
      signal.addEventListener('abort', abort, { once: true });
      this.#abort = () => {
        signal.removeEventListener('abort', abort);
      };
    }
  }

  async request(method: string, params: unknown): Promise<unknown> {
    if (this.#closed) throw new Error('Codex app-server connection is closed');
    const id = this.#nextId++;
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Codex app-server timed out: ${method}`));
      }, this.#timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#child?.stdin?.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  /** Fire-and-forget notification (e.g. the `initialized` handshake after `initialize`). */
  notify(method: string, params?: unknown): void {
    if (this.#closed) return;
    this.#child?.stdin?.write(
      `${JSON.stringify(params === undefined ? { method } : { method, params })}\n`,
    );
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#abort?.();
    this.#failAll(new Error('Codex app-server connection closed'));
    await this.#terminate();
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    for (;;) {
      const newline = this.#buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line) continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof message !== 'object' || message === null) continue;
      const record = message as { id?: unknown; result?: unknown; error?: unknown };
      if (typeof record.id !== 'number') continue;
      const item = this.#pending.get(record.id);
      if (!item) continue;
      this.#pending.delete(record.id);
      clearTimeout(item.timer);
      if (record.error !== undefined && record.error !== null) {
        const text =
          typeof record.error === 'object' && 'message' in record.error
            ? String((record.error as { message?: unknown }).message)
            : 'Codex app-server request failed';
        item.reject(new Error(text));
      } else {
        item.resolve(record.result);
      }
    }
  }

  #failAll(error: Error): void {
    for (const item of this.#pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    this.#pending.clear();
  }
}
