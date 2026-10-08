import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { WorkspaceJail } from './fs.js';
import {
  PAGE_SNAPSHOT_EXPRESSION,
  parseConsoleEvent,
  parseLogEvent,
  parseExceptionEvent,
  parseFailedRequest,
  parsePageSnapshot,
} from './page-check-results.js';

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
  if (
    /^[a-z][a-z\d+.-]*:/i.test(target) ||
    path.isAbsolute(target) ||
    path.win32.isAbsolute(target) ||
    !/\.html$/i.test(target) ||
    target.split(/[\\/]/).includes('..')
  )
    throw new Error('check_page requires a workspace-relative .html path');
  return { file: target };
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

type EventListener = (method: string, params: unknown) => void;
class DevTools {
  private nextId = 0;
  private readonly pending = new Map<
    number,
    { resolve: (result: Record<string, unknown>) => void; reject: (error: Error) => void }
  >();
  listener: EventListener | undefined;
  private constructor(
    private readonly socket: WebSocket,
    private readonly signal: AbortSignal,
  ) {
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        result?: Record<string, unknown>;
        error?: { message: string };
        method?: string;
        params?: unknown;
      };
      if (message.id !== undefined) {
        const call = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) call?.reject(new Error(message.error.message));
        else call?.resolve(message.result ?? {});
      } else if (message.method) this.listener?.(message.method, message.params);
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
    const socket = new WebSocket(url);
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
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
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
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(22_000)]);
  const profile = await mkdtemp(path.join(tmpdir(), 'ferry-page-check-'));
  let child: ChildProcess | undefined;
  let cdp: DevTools | undefined;
  const screenshots: string[] = [];
  const pages: (ReturnType<typeof parsePageSnapshot> & {
    width: number;
    console: { level: string; text: string }[];
    exceptions: string[];
    failedRequests: ReturnType<typeof parseFailedRequest>[];
    screenshot?: string;
  })[] = [];
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
    cdp = await DevTools.connect(endpoint, signal);
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
    for (const width of args.widths) {
      const console: { level: string; text: string }[] = [];
      const exceptions: string[] = [];
      const failedRequests: ReturnType<typeof parseFailedRequest>[] = [];
      const requests = new Map<string, string>();
      const navigationState = { loaded: false };
      cdp.listener = (method, params) => {
        if (method === 'Page.loadEventFired') navigationState.loaded = true;
        else if (method === 'Runtime.consoleAPICalled') {
          const entry = parseConsoleEvent(params);
          if (entry) console.push(entry);
        } else if (method === 'Log.entryAdded') {
          const entry = parseLogEvent(params);
          if (entry) console.push(entry);
        } else if (method === 'Runtime.exceptionThrown') {
          const entry = parseExceptionEvent(params);
          if (entry) exceptions.push(entry);
        } else if (method === 'Network.requestWillBeSent') {
          const event = z
            .object({ requestId: z.string(), request: z.object({ url: z.string() }) })
            .parse(params);
          requests.set(event.requestId, event.request.url);
        } else if (method === 'Network.responseReceived') {
          const event = z
            .object({
              type: z.string(),
              response: z.object({ url: z.string(), status: z.number() }),
            })
            .parse(params);
          if (event.response.status >= 400)
            failedRequests.push(
              parseFailedRequest(event.response.url, {
                type: event.type,
                errorText: `HTTP ${String(event.response.status)}`,
              }),
            );
        } else if (method === 'Network.loadingFailed') {
          const event = z.object({ requestId: z.string() }).parse(params);
          failedRequests.push(
            parseFailedRequest(requests.get(event.requestId) ?? '(unknown)', params),
          );
        }
      };
      await cdp.command(
        'Emulation.setDeviceMetricsOverride',
        { width, height: 900, deviceScaleFactor: 1, mobile: false },
        sessionId,
      );
      const navigation = await cdp.command('Page.navigate', { url }, sessionId);
      if (typeof navigation.errorText === 'string')
        throw new Error(`check_page navigation failed: ${navigation.errorText}`);
      while (!navigationState.loaded) await delay(25, undefined, { signal });
      await delay(args.waitMs, undefined, { signal });
      const evaluated = await cdp.command(
        'Runtime.evaluate',
        { expression: PAGE_SNAPSHOT_EXPRESSION, returnByValue: true },
        sessionId,
      );
      const snapshot = parsePageSnapshot(
        z.object({ value: z.unknown() }).parse(evaluated.result).value,
      );
      let screenshot: string | undefined;
      if (args.screenshot) {
        const directory = path.join(
          options.dataDir,
          'sessions',
          path.basename(options.sessionId),
          'page-check',
        );
        await mkdir(directory, { recursive: true });
        screenshot = path.join(directory, `${randomUUID()}-${String(width)}.png`);
        const shot = await cdp.command(
          'Page.captureScreenshot',
          { format: 'png', captureBeyondViewport: false },
          sessionId,
        );
        await writeFile(screenshot, Buffer.from(z.string().parse(shot.data), 'base64'));
        screenshots.push(screenshot);
      }
      pages.push({
        width,
        ...snapshot,
        console,
        exceptions,
        failedRequests,
        ...(screenshot ? { screenshot } : {}),
      });
    }
    return { target: args.target, pages, screenshots };
  } finally {
    cdp?.close();
    if (child) await stopBrowser(child);
    await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}
