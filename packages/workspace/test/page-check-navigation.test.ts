import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  capturePageWidths,
  NavigationLoadWatcher,
  type PageCommandClient,
  type PageEventListener,
} from '../src/page-check-navigation.js';

vi.setConfig({ testTimeout: 30_000 });

interface NavPlan {
  loaderId?: string;
  frameId?: string;
  isDownload?: boolean;
  errorText?: string;
  autoLoad?: boolean;
  consoleEvents?: { level: string; text: string }[];
}

class FakeCdp implements PageCommandClient {
  listener: PageEventListener | undefined;
  readonly commands: string[] = [];
  readonly navigations: string[] = [];
  private targetNavigations = 0;
  private evaluateCalls = 0;
  constructor(
    private readonly targetPlan: (index: number) => NavPlan,
    private readonly resetPlan: () => NavPlan = () => ({}),
  ) {}
  get evaluateCount(): number {
    return this.evaluateCalls;
  }
  command(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<Record<string, unknown>> {
    this.commands.push(method);
    if (method === 'Page.navigate') {
      const url = typeof params.url === 'string' ? params.url : '';
      this.navigations.push(url);
      const plan =
        url === 'about:blank' ? this.resetPlan() : this.targetPlan(this.targetNavigations++);
      const frameId = plan.frameId ?? 'main-frame';
      const result: Record<string, unknown> = { frameId };
      const loaderId = plan.loaderId;
      if (loaderId) result.loaderId = loaderId;
      if (plan.isDownload !== undefined) result.isDownload = plan.isDownload;
      if (plan.errorText !== undefined) result.errorText = plan.errorText;
      if (plan.autoLoad === false || !loaderId) return Promise.resolve(result);
      return Promise.resolve(result).then((value) => {
        this.emit('Page.lifecycleEvent', { name: 'load', loaderId, frameId }, sessionId);
        for (const entry of plan.consoleEvents ?? [])
          this.emit(
            'Runtime.consoleAPICalled',
            { type: entry.level, args: [{ value: entry.text }] },
            sessionId,
          );
        return value;
      });
    }
    if (method === 'Runtime.evaluate') {
      this.evaluateCalls += 1;
      return Promise.resolve({
        result: {
          value: { title: 'Fake', text: 'body', clientWidth: 375, scrollWidth: 480, offenders: [] },
        },
      });
    }
    if (method === 'Page.captureScreenshot')
      return Promise.resolve({ data: Buffer.from('fake-png').toString('base64') });
    return Promise.resolve({});
  }
  emit(method: string, params: unknown, sessionId?: string) {
    this.listener?.(method, params, sessionId);
  }
}

const signalled = () => new AbortController().signal;
const sessionId = 'selected-session';
const fixtureUrl = 'file:///fixture.html';

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
}

describe('NavigationLoadWatcher', () => {
  it('ignores the untagged bare load event and waits for the requested loader', () => {
    const watcher = new NavigationLoadWatcher();
    watcher.observe('Page.lifecycleEvent', { name: 'load', loaderId: 'old-document' });
    watcher.observe('Page.frameNavigated', {
      frame: { id: 'main-frame', loaderId: 'requested-document' },
    });
    watcher.observe('Page.loadEventFired', { timestamp: 1 });
    expect(watcher.isLoaded('requested-document')).toBe(false);
    watcher.observe('Page.lifecycleEvent', { name: 'load', loaderId: 'requested-document' });
    expect(watcher.isLoaded('requested-document')).toBe(true);
  });

  it('treats a navigation without a loader id as not loaded', () => {
    const watcher = new NavigationLoadWatcher();
    expect(watcher.isLoaded(undefined)).toBe(false);
    expect(watcher.isLoaded('')).toBe(false);
    expect(watcher.isLoaded('L1')).toBe(false);
  });

  it('rejects a load lifecycle from a subframe', () => {
    const watcher = new NavigationLoadWatcher({ sessionId, frameId: 'main-frame' });
    watcher.observe(
      'Page.lifecycleEvent',
      { name: 'load', loaderId: 'L1', frameId: 'sub-frame' },
      sessionId,
    );
    expect(watcher.isLoaded('L1')).toBe(false);
    watcher.observe(
      'Page.lifecycleEvent',
      { name: 'load', loaderId: 'L1', frameId: 'main-frame' },
      sessionId,
    );
    expect(watcher.isLoaded('L1')).toBe(true);
  });

  it('rejects a load lifecycle from another session', () => {
    const watcher = new NavigationLoadWatcher({ sessionId, frameId: 'main-frame' });
    watcher.observe(
      'Page.lifecycleEvent',
      { name: 'load', loaderId: 'L1', frameId: 'main-frame' },
      'other-session',
    );
    expect(watcher.isLoaded('L1')).toBe(false);
    watcher.observe(
      'Page.lifecycleEvent',
      { name: 'load', loaderId: 'L1', frameId: 'main-frame' },
      sessionId,
    );
    expect(watcher.isLoaded('L1')).toBe(true);
  });

  it('rejects a load lifecycle when the frame or session identity is missing', () => {
    const watcher = new NavigationLoadWatcher({ sessionId, frameId: 'main-frame' });
    watcher.observe('Page.lifecycleEvent', { name: 'load', loaderId: 'L1' }, sessionId);
    expect(watcher.isLoaded('L1')).toBe(false);
    watcher.observe(
      'Page.lifecycleEvent',
      { name: 'load', loaderId: 'L1', frameId: 'main-frame' },
      undefined,
    );
    expect(watcher.isLoaded('L1')).toBe(false);
    watcher.observe(
      'Page.lifecycleEvent',
      { name: 'load', loaderId: 'L1', frameId: 'main-frame' },
      sessionId,
    );
    expect(watcher.isLoaded('L1')).toBe(true);
  });
});

describe('capturePageWidths navigation readiness', () => {
  it('resets to a blank document and loads the requested URL fresh for every width', async () => {
    const client = new FakeCdp((index) => ({ loaderId: `L${String(index)}` }));
    const result = await capturePageWidths({
      client,
      sessionId,
      url: fixtureUrl,
      widths: [375, 1280],
      waitMs: 0,
      screenshot: false,
      screenshotDirectory: 'unused',
      signal: signalled(),
    });
    expect(result.pages.map((page) => page.width)).toEqual([375, 1280]);
    expect(client.navigations).toEqual(['about:blank', fixtureUrl, 'about:blank', fixtureUrl]);
  });

  it('does not snapshot until the requested loader load is released', async () => {
    const client = new FakeCdp(() => ({ loaderId: 'L1', autoLoad: false }));
    const controller = new AbortController();
    try {
      const pending = capturePageWidths({
        client,
        sessionId,
        url: fixtureUrl,
        widths: [375],
        waitMs: 0,
        screenshot: false,
        screenshotDirectory: 'unused',
        signal: controller.signal,
      });
      await waitFor(() => client.navigations.includes(fixtureUrl));
      expect(client.evaluateCount).toBe(0);
      client.emit(
        'Page.lifecycleEvent',
        { name: 'load', loaderId: 'L1', frameId: 'main-frame' },
        sessionId,
      );
      const result = await pending;
      expect(result.pages).toHaveLength(1);
      expect(client.evaluateCount).toBe(1);
    } finally {
      controller.abort();
    }
  });

  it('rejects a target navigation that returns no loader id without snapshotting', async () => {
    const client = new FakeCdp(() => ({}));
    await expect(
      capturePageWidths({
        client,
        sessionId,
        url: fixtureUrl,
        widths: [375],
        waitMs: 0,
        screenshot: false,
        screenshotDirectory: 'unused',
        signal: signalled(),
      }),
    ).rejects.toThrow(/could not confirm a fresh document/i);
    expect(client.evaluateCount).toBe(0);
  });

  it('rejects a download navigation without snapshotting', async () => {
    const client = new FakeCdp(() => ({ isDownload: true }));
    await expect(
      capturePageWidths({
        client,
        sessionId,
        url: fixtureUrl,
        widths: [375],
        waitMs: 0,
        screenshot: false,
        screenshotDirectory: 'unused',
        signal: signalled(),
      }),
    ).rejects.toThrow(/download/i);
    expect(client.evaluateCount).toBe(0);
  });

  it('stops waiting and rejects when the signal is cancelled', async () => {
    const client = new FakeCdp(() => ({ loaderId: 'L1', autoLoad: false }));
    const controller = new AbortController();
    const pending = capturePageWidths({
      client,
      sessionId,
      url: fixtureUrl,
      widths: [375],
      waitMs: 0,
      screenshot: false,
      screenshotDirectory: 'unused',
      signal: controller.signal,
    });
    await waitFor(() => client.navigations.includes(fixtureUrl));
    controller.abort(new DOMException('Aborted', 'AbortError'));
    await expect(pending).rejects.toThrow();
  });

  it('collects per-width console events and writes a screenshot for each width', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'page-check-nav-'));
    try {
      const client = new FakeCdp((index) => ({
        loaderId: `L${String(index)}`,
        consoleEvents: [{ level: 'error', text: `width-${String(index)}` }],
      }));
      const result = await capturePageWidths({
        client,
        sessionId,
        url: fixtureUrl,
        widths: [375, 1280],
        waitMs: 0,
        screenshot: true,
        screenshotDirectory: directory,
        signal: signalled(),
      });
      expect(result.pages[0]?.console).toContainEqual({ level: 'error', text: 'width-0' });
      expect(result.pages[1]?.console).toContainEqual({ level: 'error', text: 'width-1' });
      expect(result.screenshots).toHaveLength(2);
      for (const shot of result.screenshots)
        expect((await readFile(shot)).length).toBeGreaterThan(0);
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });
});
