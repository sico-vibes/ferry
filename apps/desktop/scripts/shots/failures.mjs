import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export const name = 'failures';
export async function run(page, ctx) {
  const directory = process.env.FERRY_FAILURE_SHOTS ?? ctx.screenshotDirectory;
  await mkdir(directory, { recursive: true });
  await page.goto(new URL('/models?speed=0', ctx.url).href);
  await page.getByRole('switch', { name: 'Enable Groq', exact: true }).waitFor();
  await page.getByRole('switch', { name: 'Enable Groq', exact: true }).click();
  await page.waitForFunction(() => localStorage.getItem('ferry.mock.v1') !== null);
  await page.evaluate(() => {
    const fixture = JSON.parse(localStorage.getItem('ferry.mock.v1'));
    const groq = fixture.data.providers.find((provider) => provider.id === 'groq');
    const now = new Date();
    fixture.data.requestFailures = Array.from({ length: 6 }, (_, index) => ({
      id: `shot-failure-${index}`,
      at: new Date(now.getTime() - (6 - index) * 60_000).toISOString(),
      providerId: 'groq',
      modelRef: index === 0 ? 'groq/qwen/qwen3.8-27b' : 'groq/openai/gpt-oss-120b',
      keyId: 'groq:1',
      requestId: `shot-request-${index}`,
      sessionId: null,
      source: 'agent',
      kind: index === 0 ? 'rate_limit' : 'server',
      statusCode: index === 0 ? 429 : 502,
      message:
        index === 0 ? 'Rate limit reached; retry after reset.' : '502 Upstream service error.',
      counted: index === 0 ? 0 : 1,
    }));
    fixture.data.failureResets = {};
    groq.enabled = false;
    groq.pausedReason = {
      kind: 'failed_requests',
      at: now.toISOString(),
      failedRequests: 5,
      lastError: '502 Upstream service error.',
      lastKind: 'server',
      models: ['groq/openai/gpt-oss-120b'],
    };
    localStorage.setItem('ferry.mock.v1', JSON.stringify(fixture));
  });
  for (const theme of ['dark', 'light']) {
    await page.evaluate((value) => {
      const fixture = JSON.parse(localStorage.getItem('ferry.mock.v1'));
      fixture.data.settings.theme = value;
      localStorage.setItem('ferry.mock.v1', JSON.stringify(fixture));
    }, theme);
    for (const width of [1440, 1280, 1024]) {
      await page.setViewportSize({ width, height: 900 });
      for (const route of ['models', 'health']) {
        await page.goto(
          new URL(
            route === 'health' ? '/models/health?speed=0#failures' : '/models?speed=0',
            ctx.url,
          ).href,
        );
        await page
          .getByRole('heading', { name: 'Groq was paused after 5 failed requests.', exact: true })
          .waitFor();
        if (route === 'health')
          await page.getByRole('heading', { name: 'Recent failures', exact: true }).waitFor();
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({ path: join(directory, `${route}-${theme}-${width}.png`) });
      }
    }
    // Browser zoom simulation exercises layout at 125%, not just pixel density.
    await page.setViewportSize({ width: 1440, height: 900 });
    for (const route of ['models', 'health']) {
      await page.goto(
        new URL(route === 'health' ? '/models/health?speed=0#failures' : '/models?speed=0', ctx.url)
          .href,
      );
      await page
        .getByRole('heading', { name: 'Groq was paused after 5 failed requests.', exact: true })
        .waitFor();
      if (route === 'health')
        await page.getByRole('heading', { name: 'Recent failures', exact: true }).waitFor();
      await page.evaluate(() => {
        document.documentElement.style.zoom = '1.25';
      });
      await page.screenshot({ path: join(directory, `${route}-${theme}-125pct.png`) });
    }
  }
}
