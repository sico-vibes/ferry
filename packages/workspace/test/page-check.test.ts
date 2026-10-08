import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceJail } from '../src/fs.js';
import { checkPage, CheckPageSchema, findBrowser, parsePageTarget } from '../src/page-check.js';
import {
  parseConsoleEvent,
  parseLogEvent,
  parseExceptionEvent,
  parseFailedRequest,
  parsePageSnapshot,
} from '../src/page-check-results.js';

describe('check_page parsers', () => {
  it('reports overflow, selectors, title and bounded visible text', () => {
    expect(
      parsePageSnapshot({
        title: 'Fixture',
        text: 'a'.repeat(700),
        clientWidth: 375,
        scrollWidth: 800,
        offenders: [{ selector: '#wide', right: 800 }],
      }),
    ).toEqual({
      title: 'Fixture',
      text: 'a'.repeat(600),
      clientWidth: 375,
      scrollWidth: 800,
      overflow: true,
      offenders: [{ selector: '#wide', right: 800 }],
    });
  });
  it('parses console warnings/errors and uncaught exceptions', () => {
    expect(
      parseConsoleEvent({
        type: 'error',
        args: [{ value: 'Broken' }, { description: 'Error: fixture' }],
      }),
    ).toEqual({ level: 'error', text: 'Broken Error: fixture' });
    expect(parseConsoleEvent({ type: 'warning', args: [{ value: 42 }] })?.text).toBe('42');
    expect(parseConsoleEvent({ type: 'log', args: [] })).toBeNull();
    expect(
      parseExceptionEvent({
        exceptionDetails: { text: 'Uncaught', exception: { description: 'Error: fixture' } },
      }),
    ).toBe('Error: fixture');
    expect(parseExceptionEvent({})).toBeNull();
    expect(parseLogEvent({ entry: { level: 'error', text: 'CSP violation' } })).toEqual({
      level: 'error',
      text: 'CSP violation',
    });
    expect(parseLogEvent({ entry: { level: 'info', text: 'Information' } })).toBeNull();
  });
  it('lists offline font/CDN failures separately from app failures', () => {
    expect(
      parseFailedRequest('https://fonts.gstatic.com/font.woff', {
        errorText: 'net::ERR_INTERNET_DISCONNECTED',
        type: 'Font',
      }).ignored,
    ).toBe(true);
    expect(
      parseFailedRequest('https://cdn.example.com/library.js', {
        errorText: 'net::ERR_NAME_NOT_RESOLVED',
      }).ignored,
    ).toBe(true);
    expect(
      parseFailedRequest('http://localhost/app.js', { errorText: 'net::ERR_CONNECTION_REFUSED' })
        .ignored,
    ).toBe(false);
  });
  it('restricts targets and applies bounded defaults', () => {
    expect(CheckPageSchema.parse({ target: 'blog.html' })).toEqual({
      target: 'blog.html',
      widths: [375, 1280],
      waitMs: 800,
      screenshot: true,
    });
    expect(parsePageTarget('http://localhost:3000')).toEqual({ url: 'http://localhost:3000/' });
    for (const target of [
      'https://example.com',
      'http://localhost.example.com',
      'http://user@localhost',
      '../blog.html',
      'C:\\blog.html',
      'file:///blog.html',
      'blog.js',
    ])
      expect(() => parsePageTarget(target)).toThrow();
    expect(() => CheckPageSchema.parse({ target: 'blog.html', waitMs: 5001 })).toThrow();
  });
});

const browser = await findBrowser();
it.skipIf(process.platform === 'darwin')(
  'returns a useful unavailable result without failing the tool',
  { timeout: 30_000 },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ferry-page-unavailable-'));
    try {
      await writeFile(path.join(root, 'fixture.html'), '<title>Fixture</title>', 'utf8');
      for (const key of [
        'FERRY_BROWSER_PATH',
        'ProgramFiles',
        'ProgramFiles(x86)',
        'LOCALAPPDATA',
        'PATH',
      ])
        vi.stubEnv(key, '');
      expect(
        await checkPage(
          new WorkspaceJail(root),
          { target: 'fixture.html' },
          { dataDir: root, sessionId: 'session_fixture', signal: new AbortController().signal },
        ),
      ).toEqual({
        unavailable: 'check_page unavailable: no Chromium-based browser found',
        screenshots: [],
      });
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  },
);
it.skipIf(!browser)(
  'checks a real offline page and reaps the browser/profile, also on abort',
  { timeout: 30_000 },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ferry-page-test-'));
    const dataDir = path.join(root, 'data');
    let pid = 0;
    let profile = '';
    const onBrowserStarted = (startedPid: number, startedProfile: string) => {
      pid = startedPid;
      profile = startedProfile;
    };
    try {
      await writeFile(
        path.join(root, 'fixture.html'),
        '<!doctype html><title>Overflow fixture</title><div id="wide" style="width:1600px">Visible fixture text</div><script>localStorage.setItem("fixture", "yes"); console.error("deliberate fixture error"); console.warn("fixture warning"); setTimeout(() => { throw new Error("uncaught fixture"); }, 5);</script>',
        'utf8',
      );
      const result = await checkPage(
        new WorkspaceJail(root),
        { target: 'fixture.html', waitMs: 50 },
        {
          dataDir,
          sessionId: 'session_fixture',
          signal: new AbortController().signal,
          onBrowserStarted,
        },
      );
      expect('pages' in result).toBe(true);
      if (!('pages' in result)) throw new Error('Browser became unavailable');
      expect(result.pages.map((page) => page.width)).toEqual([375, 1280]);
      for (const page of result.pages) {
        expect(page.overflow).toBe(true);
        expect(page.offenders).toContainEqual({ selector: '#wide', right: 1608 });
        expect(page.title).toBe('Overflow fixture');
        expect(page.console).toContainEqual({ level: 'error', text: 'deliberate fixture error' });
        expect(page.exceptions.join('\n')).toContain('uncaught fixture');
        expect(page.text).toContain('Visible fixture text');
        expect(page.exceptions.join('\n')).not.toContain('SecurityError');
      }
      expect(result.screenshots).toHaveLength(2);
      for (const shot of result.screenshots) {
        expect(shot.startsWith(dataDir)).toBe(true);
        await access(shot);
        expect((await readFile(shot)).subarray(0, 8)).toEqual(
          Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        );
      }
      await expect(access(profile)).rejects.toThrow();
      expect(() => process.kill(pid, 0)).toThrow();
      const controller = new AbortController();
      await expect(
        checkPage(
          new WorkspaceJail(root),
          { target: 'fixture.html' },
          {
            dataDir,
            sessionId: 'session_fixture',
            signal: controller.signal,
            onBrowserStarted: (startedPid, startedProfile) => {
              onBrowserStarted(startedPid, startedProfile);
              controller.abort();
            },
          },
        ),
      ).rejects.toThrow();
      await expect(access(profile)).rejects.toThrow();
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  },
);
