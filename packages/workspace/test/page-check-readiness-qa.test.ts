import { expect, it } from 'vitest';
import {
  capturePageWidths,
  NavigationLoadWatcher,
  type PageCommandClient,
} from '../src/page-check-navigation.js';

it('does not attribute an untagged old load event to a newly committed loader', () => {
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

it('rejects a navigation that downloads instead of capturing the previous document', async () => {
  let evaluated = false;
  const client: PageCommandClient = {
    listener: undefined,
    command(method) {
      if (method === 'Page.navigate')
        return Promise.resolve({ frameId: 'main-frame', isDownload: true });
      if (method === 'Runtime.evaluate') {
        evaluated = true;
        return Promise.resolve({
          result: {
            value: {
              title: 'Previous document',
              text: 'Stale evidence',
              clientWidth: 375,
              scrollWidth: 375,
              offenders: [],
            },
          },
        });
      }
      return Promise.resolve({});
    },
  };
  await expect(
    capturePageWidths({
      client,
      sessionId: 'selected-session',
      url: 'http://127.0.0.1:3000/fixture',
      widths: [375],
      waitMs: 0,
      screenshot: false,
      screenshotDirectory: 'unused',
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow(/download/i);
  expect(evaluated).toBe(false);
});
