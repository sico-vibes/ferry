import { execa, type Subprocess } from 'execa';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commandInvocation } from '../index.js';

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ClaudeControlOptions {
  executable: string;
  /** Base args (e.g. an offline fixture path) placed before the control/isolation flags. */
  baseArgs?: string[];
  environment: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ClaudeControlIsolation {
  settingsPath: string;
  mcpConfigPath: string;
}

/**
 * Minimal NDJSON control client for the installed Claude Code CLI (`-p --input-format stream-json`).
 *
 * Only control requests are sent (never a user turn), so no model generation occurs. `initialize`
 * exposes models/account and `get_usage` exposes rate-limit windows. Native OAuth is preserved:
 * `--bare` is deliberately never passed. Hooks, built-in tools and MCP servers are disabled through
 * JSON settings/mcp config files rather than inline JSON, because `commandInvocation` rejects shell
 * metacharacters (quotes, `%`, `!`) in arguments. The child runs in the private temp directory that
 * holds those config files, so the user's project instructions are never loaded.
 */
export class ClaudeControlClient {
  readonly #pending = new Map<string, PendingRequest>();
  readonly #child: Subprocess | undefined;
  readonly #timeoutMs: number;
  readonly #terminate: () => Promise<void>;
  #buffer = '';
  #seq = 0;
  #closed = false;
  readonly #abort?: () => void;

  constructor(options: ClaudeControlOptions) {
    this.#timeoutMs = options.timeoutMs ?? 20_000;
    if (options.signal?.aborted === true) {
      // Never spawn a subprocess for an already-cancelled probe.
      this.#closed = true;
      this.#terminate = () => Promise.resolve();
      return;
    }
    const isolationDir = mkdtempSync(join(tmpdir(), 'ferry-claude-control-'));
    const isolation: ClaudeControlIsolation = {
      settingsPath: join(isolationDir, 'settings.json'),
      mcpConfigPath: join(isolationDir, 'mcp.json'),
    };
    this.#terminate = async () => {
      const child = this.#child;
      const pid = child?.pid;
      if (child && pid !== undefined) {
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
      rmSync(isolationDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    };
    writeFileSync(
      isolation.settingsPath,
      JSON.stringify({
        disableAllHooks: true,
        permissions: { deny: ['Bash', 'Read', 'Write', 'Edit'] },
      }),
    );
    writeFileSync(isolation.mcpConfigPath, JSON.stringify({ mcpServers: {} }));
    const invocation = commandInvocation(options.executable, [
      ...(options.baseArgs ?? []),
      ...claudeControlArgs(isolation),
    ]);
    const child = execa(invocation.file, invocation.args, {
      env: options.environment,
      cwd: isolationDir,
      extendEnv: false,
      windowsHide: true,
      buffer: false,
      reject: false,
      detached: process.platform !== 'win32',
      ...(invocation.verbatim ? { windowsVerbatimArguments: true } : {}),
    });
    this.#child = child as unknown as Subprocess;
    child.stderr.on('data', () => undefined); // May contain credentials/provider text; never log it.
    child.stdout.on('data', (chunk: Buffer | string) => {
      this.#onData(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    });
    child.stdin.on('error', () => {
      this.#failAll(new Error('Claude control stdin closed'));
    });
    void child
      .then(() => {
        this.#failAll(new Error('Claude control process exited'));
      })
      .catch(() => undefined);
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

  async request(subtype: string, extra: Record<string, unknown> = {}): Promise<unknown> {
    if (this.#closed) throw new Error('Claude control connection is closed');
    this.#seq += 1;
    const requestId = `ferry-${String(this.#seq)}`;
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new Error(`Claude control timed out: ${subtype}`));
      }, this.#timeoutMs);
      this.#pending.set(requestId, { resolve, reject, timer });
      this.#child?.stdin?.write(
        `${JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype, ...extra } })}\n`,
      );
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#abort?.();
    this.#failAll(new Error('Claude control connection closed'));
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
      const record = message as { type?: unknown; response?: unknown };
      if (record.type !== 'control_response') continue;
      const response = record.response as
        | { request_id?: unknown; subtype?: unknown; response?: unknown; error?: unknown }
        | undefined;
      const requestId = typeof response?.request_id === 'string' ? response.request_id : undefined;
      if (!requestId) continue;
      const item = this.#pending.get(requestId);
      if (!item) continue;
      this.#pending.delete(requestId);
      clearTimeout(item.timer);
      if (response?.subtype === 'success') item.resolve(response.response);
      else
        item.reject(
          new Error(
            typeof response?.error === 'string' ? response.error : 'Claude control request failed',
          ),
        );
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

/**
 * Args that keep control probing read-only and isolated from the user's project, hooks, built-in
 * tools and MCP servers. Paths (never inline JSON) avoid shell metacharacters. A user turn is never
 * sent, and native OAuth is preserved (`--bare` is never passed because it disables native auth).
 */
export function claudeControlArgs(isolation: ClaudeControlIsolation): string[] {
  return [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--no-session-persistence',
    '--tools',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    isolation.mcpConfigPath,
    '--disable-slash-commands',
    '--settings',
    isolation.settingsPath,
  ];
}
