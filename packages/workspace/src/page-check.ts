import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { WorkspaceJail } from './fs.js';
import { capturePageWidths, type PageEventListener } from './page-check-navigation.js';

const CHECK_PAGE_DEADLINE_MS = 22_000;

export const CheckPageSchema = z.object({
  target: z.string().min(1),
  widths: z.array(z.number().int().min(100).max(7680)).min(1).max(8).default([375, 1280]),
  waitMs: z.number().int().min(0).max(5000).default(800),
  screenshot: z.boolean().default(true),
});

export function parsePageTarget(target: string): { url: string } | { file: string } {
  if (/^https?:\/\//i.test(target)) {
    const url = new URL(target);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.username || url.password)
      throw new Error('check_page only accepts localhost or 127.0.0.1 URLs');
    return { url: url.href };
  }
  // file:// URLs and absolute paths are accepted; the workspace jail rejects anything outside.
  const file = /^file:\/\//i.test(target) ? fileURLToPath(target) : target;
  if (
    (/^[a-z][a-z\d+.-]*:/i.test(file) && !path.win32.isAbsolute(file)) ||
    !/\.html?$/i.test(file) ||
    file.split(/[\\/]/).includes('..')
  )
    throw new Error(
      'check_page needs an .html file in the workspace (for example "blog.html"; no server needed) or a localhost URL',
    );
  return { file };
}

export async function findBrowser(): Promise<string | null> {
  const candidates: string[] = [];
  if (process.env.FERRY_BROWSER_PATH) candidates.push(process.env.FERRY_BROWSER_PATH);
  if (process.platform === 'win32') {
    for (const root of [
      process.env.ProgramFiles,
      process.env['ProgramFiles(x86)'],
      process.env.LOCALAPPDATA,
    ].filter((value): value is string => Boolean(value))) {
      candidates.push(
        path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(root, 'Chromium', 'Application', 'chrome.exe'),
      );
    }
  } else if (process.platform === 'darwin') {
    for (const [app, binary] of [
      ['Google Chrome', 'Google Chrome'],
      ['Microsoft Edge', 'Microsoft Edge'],
      ['Chromium', 'Chromium'],
    ]) {
      if (app && binary)
        candidates.push(path.join('/Applications', `${app}.app`, 'Contents', 'MacOS', binary));
    }
  }
  for (const root of (process.env.PATH ?? '').split(path.delimiter)) {
    for (const name of ['google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge'])
      candidates.push(path.join(root, name));
  }
  for (const candidate of candidates) {
    if (
      await access(candidate).then(
        () => true,
        () => false,
      )
    )
      return candidate;
  }
  return null;
}

class DevTools {
  private nextId = 0;
  private readonly pending = new Map<
    number,
    { resolve: (result: Record<string, unknown>) => void; reject: (error: Error) => void }
  >();
  listener: PageEventListener | undefined;
  private constructor(
    private readonly socket: WebSocket,
    private readonly signal: AbortSignal,
  ) {
    socket.addEventListener('message', (event) => {
      let message: {
        id?: number;
        result?: Record<string, unknown>;
        error?: { message: string };
        method?: string;
        params?: unknown;
        sessionId?: string;
      };
      try {
        message = JSON.parse(String(event.data)) as typeof message;
      } catch {
        return;
      }
      if (message.id !== undefined) {
        const call = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) call?.reject(new Error(message.error.message));
        else call?.resolve(message.result ?? {});
      } else if (message.method) this.listener?.(message.method, message.params, message.sessionId);
    });
    const fail = () => {
      for (const call of this.pending.values())
        call.reject(new Error('check_page browser connection closed or aborted'));
      this.pending.clear();
      socket.close();
    };
    socket.addEventListener('close', fail, { once: true });
    socket.addEventListener('error', fail, { once: true });
    signal.addEventListener('abort', fail, { once: true });
    socket.addEventListener(
      'close',
      () => {
        signal.removeEventListener('abort', fail);
      },
      {
        once: true,
      },
    );
  }
  static async connect(url: string, signal: AbortSignal): Promise<DevTools> {
    signal.throwIfAborted();
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (error) {
      throw error instanceof Error
        ? error
        : new Error('check_page could not open the browser socket');
    }
    const client = new DevTools(socket, signal);
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        socket.close();
        reject(new Error('check_page connection aborted'));
      };
      const clear = () => {
        signal.removeEventListener('abort', abort);
      };
      signal.addEventListener('abort', abort, { once: true });
      socket.addEventListener(
        'open',
        () => {
          clear();
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        'error',
        () => {
          clear();
          reject(new Error('check_page could not connect to browser'));
        },
        { once: true },
      );
    });
    return client;
  }
  command(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<Record<string, unknown>> {
    this.signal.throwIfAborted();
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.socket.send(
          JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }),
        );
      } catch (error) {
        this.pending.delete(id);
        reject(
          error instanceof Error ? error : new Error('check_page could not send a browser command'),
        );
      }
    });
  }
  close() {
    this.socket.close();
  }
}

async function stopBrowser(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) =>
    child.once('exit', () => {
      resolve();
    }),
  );
  if (process.platform === 'win32' && child.pid) {
    await new Promise<void>((resolve) =>
      execFile(
        'taskkill',
        ['/pid', String(child.pid), '/t', '/f'],
        { windowsHide: true, timeout: 3000 },
        () => {
          resolve();
        },
      ),
    );
  } else if (child.pid) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
  await Promise.race([exited, delay(500)]);
}

export async function checkPage(
  jail: WorkspaceJail,
  raw: unknown,
  options: {
    dataDir: string;
    sessionId: string;
    signal: AbortSignal;
    onBrowserStarted?: (pid: number, profile: string) => void;
  },
) {
  const args = CheckPageSchema.parse(raw);
  const target = parsePageTarget(args.target);
  const url = 'url' in target ? target.url : pathToFileURL(await jail.resolve(target.file)).href;
  options.signal.throwIfAborted();
  const browser = await findBrowser();
  if (!browser)
    return {
      unavailable: 'check_page unavailable: no Chromium-based browser found',
      screenshots: [] as string[],
    };
  const deadline = AbortSignal.timeout(CHECK_PAGE_DEADLINE_MS);
  const signal = AbortSignal.any([options.signal, deadline]);
  const profile = await mkdtemp(path.join(tmpdir(), 'ferry-page-check-'));
  let child: ChildProcess | undefined;
  let cdp: DevTools | undefined;
  let stage = 'browser startup';
  try {
    child = spawn(
      browser,
      [
        '--headless=new',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-sync',
        '--remote-debugging-port=0',
        '--remote-debugging-address=127.0.0.1',
        `--user-data-dir=${profile}`,
        ...(process.platform === 'linux' && process.getuid?.() === 0 ? ['--no-sandbox'] : []),
        'about:blank',
      ],
      { windowsHide: true, stdio: 'ignore', detached: process.platform !== 'win32' },
    );
    let launchError: Error | undefined;
    child.on('error', (error) => {
      launchError = error;
    });
    if (child.pid) options.onBrowserStarted?.(child.pid, profile);
    let endpoint: string | undefined;
    while (!endpoint) {
      signal.throwIfAborted();
      if (launchError) throw launchError;
      if (child.exitCode !== null)
        throw new Error('check_page browser exited before becoming ready');
      const active = await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8').catch(
        () => '',
      );
      const [port, route] = active.trim().split(/\r?\n/);
      if (port && route) endpoint = `ws://127.0.0.1:${port}${route}`;
      else await delay(50, undefined, { signal });
    }
    stage = 'devtools connect';
    cdp = await DevTools.connect(endpoint, signal);
    stage = 'target setup';
    const created = await cdp.command('Target.createTarget', { url: 'about:blank' });
    const attached = await cdp.command('Target.attachToTarget', {
      targetId: created.targetId,
      flatten: true,
    });
    const sessionId = z.string().parse(attached.sessionId);
    await cdp.command('Page.enable', {}, sessionId);
    await cdp.command('Runtime.enable', {}, sessionId);
    await cdp.command('Network.enable', {}, sessionId);
    await cdp.command('Log.enable', {}, sessionId);
    await cdp.command('Page.setLifecycleEventsEnabled', { enabled: true }, sessionId);
    const frameTree = await cdp.command('Page.getFrameTree', {}, sessionId);
    const mainFrameId = z
      .object({ frameTree: z.object({ frame: z.object({ id: z.string() }) }) })
      .parse(frameTree).frameTree.frame.id;
    stage = 'page capture';
    const screenshotDirectory = path.join(
      options.dataDir,
      'sessions',
      path.basename(options.sessionId),
      'page-check',
    );
    const { pages, screenshots } = await capturePageWidths({
      client: cdp,
      sessionId,
      mainFrameId,
      url,
      widths: args.widths,
      waitMs: args.waitMs,
      screenshot: args.screenshot,
      screenshotDirectory,
      signal,
      onStage: (next) => {
        stage = next;
      },
    });
    return { target: args.target, pages, screenshots };
  } catch (error) {
    // Keep the tool deadline distinguishable from a caller abort, and say which
    // stage stalled instead of surfacing an opaque AbortError.
    if (!options.signal.aborted && deadline.aborted)
      throw new Error(
        `check_page timed out after ${String(CHECK_PAGE_DEADLINE_MS)}ms during ${stage}`,
        { cause: error },
      );
    throw error;
  } finally {
    cdp?.close();
    if (child) await stopBrowser(child);
    await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}
