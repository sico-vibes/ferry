import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import {
  PAGE_SNAPSHOT_EXPRESSION,
  parseConsoleEvent,
  parseLogEvent,
  parseExceptionEvent,
  parseFailedRequest,
  parsePageSnapshot,
} from './page-check-results.js';

export type PageEventListener = (method: string, params: unknown, sessionId?: string) => void;

/** Minimal CDP surface used by the capture loop, so tests can drive it with a fake. */
export interface PageCommandClient {
  command(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<Record<string, unknown>>;
  listener: PageEventListener | undefined;
}

export type CapturedPage = ReturnType<typeof parsePageSnapshot> & {
  width: number;
  console: { level: string; text: string }[];
  exceptions: string[];
  failedRequests: ReturnType<typeof parseFailedRequest>[];
  screenshot?: string;
};

/**
 * Correlates page-load readiness with the selected session/frame and the loader
 * id of the requested navigation, using loader-scoped `Page.lifecycleEvent`
 * load events only. `Page.loadEventFired` carries no loader/frame identity, so
 * it cannot be attributed to a document and is never treated as a readiness
 * signal; a navigation that returns no loader id likewise does not prove the
 * requested document loaded.
 */
export class NavigationLoadWatcher {
  private readonly loadedLoaderIds = new Set<string>();
  constructor(private readonly expected: { sessionId?: string; frameId?: string } = {}) {}

  /** Returns true when the event is a lifecycle signal this watcher consumes. */
  observe(method: string, params: unknown, sessionId?: string): boolean {
    if (method !== 'Page.lifecycleEvent') return false;
    if (this.expected.sessionId && sessionId !== this.expected.sessionId) return true;
    const event = z
      .object({ name: z.string(), loaderId: z.string(), frameId: z.string().optional() })
      .safeParse(params);
    if (!event.success || event.data.name !== 'load' || event.data.loaderId.length === 0)
      return true;
    if (this.expected.frameId && event.data.frameId !== this.expected.frameId) return true;
    this.loadedLoaderIds.add(event.data.loaderId);
    return true;
  }

  isLoaded(loaderId: string | undefined): boolean {
    return (
      typeof loaderId === 'string' && loaderId.length > 0 && this.loadedLoaderIds.has(loaderId)
    );
  }
}

export async function capturePageWidths(options: {
  client: PageCommandClient;
  sessionId: string;
  mainFrameId?: string;
  url: string;
  widths: number[];
  waitMs: number;
  screenshot: boolean;
  screenshotDirectory: string;
  signal: AbortSignal;
  onStage?: (stage: string) => void;
}): Promise<{ pages: CapturedPage[]; screenshots: string[] }> {
  const {
    client,
    sessionId,
    mainFrameId,
    url,
    widths,
    waitMs,
    screenshot,
    screenshotDirectory,
    signal,
    onStage,
  } = options;
  const screenshots: string[] = [];
  const pages: CapturedPage[] = [];
  for (const width of widths) {
    const consoleEntries: { level: string; text: string }[] = [];
    const exceptions: string[] = [];
    const failedRequests: ReturnType<typeof parseFailedRequest>[] = [];
    const requests = new Map<string, string>();
    const watcher = mainFrameId
      ? new NavigationLoadWatcher({ sessionId, frameId: mainFrameId })
      : new NavigationLoadWatcher({ sessionId });
    client.listener = (method, params, eventSessionId) => {
      if (eventSessionId && eventSessionId !== sessionId) return;
      if (watcher.observe(method, params, eventSessionId)) return;
      if (method === 'Runtime.consoleAPICalled') {
        const entry = parseConsoleEvent(params);
        if (entry) consoleEntries.push(entry);
      } else if (method === 'Log.entryAdded') {
        const entry = parseLogEvent(params);
        if (entry) consoleEntries.push(entry);
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
    onStage?.(`width ${String(width)} navigate`);
    await client.command(
      'Emulation.setDeviceMetricsOverride',
      { width, height: 900, deviceScaleFactor: 1, mobile: false },
      sessionId,
    );
    // Reset to a blank document first so each width loads the requested URL as a
    // fresh, script-running document rather than a same-document navigation that
    // would neither rerun page scripts nor emit a load lifecycle.
    await client.command('Page.navigate', { url: 'about:blank' }, sessionId);
    const navigation = await client.command('Page.navigate', { url }, sessionId);
    if (navigation.isDownload === true)
      throw new Error(
        `check_page navigation for ${url} started a download instead of loading a page`,
      );
    if (typeof navigation.errorText === 'string')
      throw new Error(`check_page navigation failed: ${navigation.errorText}`);
    const loaderId =
      typeof navigation.loaderId === 'string' && navigation.loaderId.length > 0
        ? navigation.loaderId
        : undefined;
    if (!loaderId)
      throw new Error(
        `check_page could not confirm a fresh document loaded for ${url} (width ${String(width)})`,
      );
    onStage?.(`width ${String(width)} load`);
    while (!watcher.isLoaded(loaderId)) await delay(25, undefined, { signal });
    await delay(waitMs, undefined, { signal });
    onStage?.(`width ${String(width)} snapshot`);
    const evaluated = await client.command(
      'Runtime.evaluate',
      { expression: PAGE_SNAPSHOT_EXPRESSION, returnByValue: true },
      sessionId,
    );
    const snapshot = parsePageSnapshot(
      z.object({ value: z.unknown() }).parse(evaluated.result).value,
    );
    let screenshotPath: string | undefined;
    if (screenshot) {
      onStage?.(`width ${String(width)} screenshot`);
      await mkdir(screenshotDirectory, { recursive: true });
      screenshotPath = path.join(screenshotDirectory, `${randomUUID()}-${String(width)}.png`);
      const shot = await client.command(
        'Page.captureScreenshot',
        { format: 'png', captureBeyondViewport: false },
        sessionId,
      );
      await writeFile(screenshotPath, Buffer.from(z.string().parse(shot.data), 'base64'));
      screenshots.push(screenshotPath);
    }
    pages.push({
      width,
      ...snapshot,
      console: consoleEntries,
      exceptions,
      failedRequests,
      ...(screenshotPath ? { screenshot: screenshotPath } : {}),
    });
  }
  return { pages, screenshots };
}
