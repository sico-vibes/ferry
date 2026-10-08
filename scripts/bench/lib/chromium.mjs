import { access, mkdtemp, readFile } from 'node:fs/promises';
import { join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { start, stop, waitFor } from './process.mjs';
import { remove } from './live.mjs';

export async function chromiumExecutable() {
  if (process.env.BENCH_CHROMIUM) {
    try {
      await access(process.env.BENCH_CHROMIUM);
      return process.env.BENCH_CHROMIUM;
    } catch {
      return null;
    }
  }
  const candidates = [];
  if (process.platform === 'win32') {
    for (const base of [
      process.env.PROGRAMFILES,
      process.env['PROGRAMFILES(X86)'],
      process.env.LOCALAPPDATA,
    ].filter(Boolean))
      candidates.push(
        join(base, 'Microsoft/Edge/Application/msedge.exe'),
        join(base, 'Google/Chrome/Application/chrome.exe'),
      );
  } else if (process.platform === 'darwin')
    candidates.push(
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    );
  else
    for (const dir of (process.env.PATH ?? '').split(delimiter))
      for (const name of ['microsoft-edge', 'google-chrome', 'chromium', 'chromium-browser'])
        candidates.push(join(dir, name));
  for (const candidate of candidates.filter(Boolean)) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      /* next */
    }
  }
  return null;
}

class DevTools {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.errors = [];
    socket.addEventListener('message', ({ data }) => {
      const event = JSON.parse(data);
      if (event.id) {
        const request = this.pending.get(event.id);
        if (!request) return;
        this.pending.delete(event.id);
        clearTimeout(request.timer);
        if (event.error) request.reject(new Error(event.error.message));
        else request.resolve(event.result);
      }
      if (event.method === 'Runtime.exceptionThrown')
        this.errors.push(event.params.exceptionDetails.text);
      if (event.method === 'Runtime.consoleAPICalled' && event.params.type === 'error')
        this.errors.push(event.params.args.map((arg) => arg.value ?? arg.description).join(' '));
      if (event.method === 'Page.javascriptDialogOpening')
        void this.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
      if (event.method === 'Fetch.requestPaused')
        void this.send('Fetch.failRequest', {
          requestId: event.params.requestId,
          errorReason: 'BlockedByClient',
        }).catch(() => {});
    });
    socket.addEventListener('close', () => {
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error('DevTools connection closed'));
      }
      this.pending.clear();
    });
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`DevTools timed out: ${method}`));
      }, 10_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
      );
    return result.result.value;
  }
  async load(file, width) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await this.send('Page.navigate', { url: pathToFileURL(file).href });
    await waitFor(() =>
      this.evaluate(
        `location.href === ${JSON.stringify(pathToFileURL(file).href)} && document.readyState === 'complete'`,
      ),
    );
  }
  async reload() {
    await this.send('Page.reload');
    await waitFor(() => this.evaluate("document.readyState === 'complete'"));
  }
}

export async function withChromium(action) {
  const executable = await chromiumExecutable();
  if (!executable) return { status: 'skipped', reason: 'skipped: no Chromium' };
  const profile = await mkdtemp(join(tmpdir(), 'ferry-bench-chromium-'));
  const child = start(
    executable,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--disable-extensions',
      '--metrics-recording-only',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost',
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      'about:blank',
    ],
    { detached: process.platform !== 'win32' },
  );
  let socket;
  try {
    let port;
    await waitFor(async () => {
      if (child.exitCode !== null) throw new Error('Chromium exited before DevTools was ready');
      try {
        port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
        return Boolean(port);
      } catch {
        return false;
      }
    });
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = pages.find((item) => item.type === 'page');
    if (!page) throw new Error('Chromium has no page target');
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    const devtools = new DevTools(socket);
    await devtools.send('Runtime.enable');
    await devtools.send('Page.enable');
    // Block all external page traffic, including optional Google Fonts. Fixtures
    // and solutions work offline; DevTools only talks to this loopback browser.
    await devtools.send('Fetch.enable', {
      patterns: [{ urlPattern: 'http://*' }, { urlPattern: 'https://*' }],
    });
    return await action(devtools);
  } finally {
    socket?.close();
    await stop(child);
    await remove(profile);
  }
}
