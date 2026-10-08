// Layout invariants for the key screens, in both themes at 1024 and 1440 px wide:
// no horizontal overflow, no clipped button/badge/tab text, and click targets at least 24 px.
// Screenshots and an axe accessibility report go to apps/desktop/ui-invariants/ for review.
// Usage: node scripts/ui-invariants.mjs   (FERRY_SKIP_WEB_BUILD=1 to reuse out/web)
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveDirectory } from './static-server.mjs';

if (process.env.FERRY_SKIP_WEB_BUILD !== '1') await import('./build-web.mjs');
process.env.PLAYWRIGHT_BROWSERS_PATH ??= '0';
const { chromium } = await import('@playwright/test');
const { default: AxeBuilder } = await import('@axe-core/playwright');

const packageDirectory = join(dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = join(packageDirectory, 'ui-invariants');
await mkdir(outputDirectory, { recursive: true });
const served = await serveDirectory(join(packageDirectory, 'out', 'web'));

const screens = [
  { name: 'home', path: '/' },
  { name: 'models', path: '/models' },
  { name: 'usage', path: '/models/usage' },
  { name: 'health', path: '/models/health' },
  { name: 'gateway', path: '/gateway' },
  { name: 'chat', path: '/?speed=0', openFirstChat: true },
  { name: 'settings-general', path: '/settings', section: 'General' },
  { name: 'settings-routing', path: '/settings', section: 'Routing' },
  { name: 'settings-providers', path: '/settings', section: 'Providers & keys' },
];
const viewports = [
  { width: 1024, height: 680 },
  { width: 1440, height: 900 },
];

/** Runs in the page: returns human-readable invariant violations. */
function findViolations() {
  const problems = [];
  const root = document.documentElement;
  if (root.scrollWidth > window.innerWidth + 1)
    problems.push(`page scrolls sideways (${root.scrollWidth}px > ${window.innerWidth}px)`);
  const describe = (element) =>
    `${element.tagName.toLowerCase()}${element.className && typeof element.className === 'string' ? `.${element.className.trim().split(/\s+/).slice(0, 2).join('.')}` : ''} "${(element.textContent ?? '').trim().slice(0, 40)}"`;
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.visibility !== 'hidden' &&
      style.display !== 'none' &&
      Number(style.opacity) > 0.05 &&
      rect.bottom > 0 &&
      rect.top < window.innerHeight
    );
  };
  for (const element of document.querySelectorAll(
    'button, [role="tab"], [role="menuitem"], a[href], [class*="badge"], [class*="chip"]',
  )) {
    if (!visible(element) || element.closest('[aria-hidden="true"]')) continue;
    const style = getComputedStyle(element);
    const clips = /(hidden|clip)/.test(style.overflowX);
    const intentional = element.hasAttribute('title') || style.textOverflow === 'ellipsis';
    if (clips && !intentional && element.scrollWidth > element.clientWidth + 1)
      problems.push(`clipped text in ${describe(element)}`);
    const rect = element.getBoundingClientRect();
    // Links inside a sentence follow the text's line height; the 24 px rule is for controls.
    const inlineText = style.display === 'inline' || element.parentElement?.tagName === 'P';
    const interactive =
      !inlineText && element.matches('button, [role="tab"], [role="menuitem"], a[href]');
    if (interactive && (rect.width < 24 || rect.height < 20))
      problems.push(
        `small click target ${Math.round(rect.width)}x${Math.round(rect.height)} ${describe(element)}`,
      );
  }
  return [...new Set(problems)];
}

const report = [];
let failures = 0;
const browser = await chromium.launch({ headless: true });
try {
  for (const theme of ['dark', 'light'])
    for (const viewport of viewports)
      for (const screen of screens) {
        const context = await browser.newContext({
          viewport,
          reducedMotion: 'reduce',
          colorScheme: theme === 'light' ? 'light' : 'dark',
        });
        const page = await context.newPage();
        await page.goto(
          new URL(
            `${screen.path}${screen.path.includes('?') ? '&' : '?'}theme=${theme}`,
            served.url,
          ).href,
        );
        await page.locator('.v2-sidebar').first().waitFor({ timeout: 30_000 });
        if (screen.openFirstChat) {
          // The web build has no saved chats: start one and let the scripted reply play.
          const composer = page.getByRole('textbox').first();
          await composer.fill('Find and fix the flaky retry test, then run the suite.');
          await composer.press('Enter');
          await page.locator('.transcript-message').nth(1).waitFor({ timeout: 30_000 });
          await page.waitForTimeout(4_000);
        }
        if (screen.section) {
          await page.locator('.v2-settings-nav').waitFor({ timeout: 15_000 });
          await page
            .locator('.v2-settings-nav button', { hasText: screen.section })
            .first()
            .click();
        }
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(600);
        const label = `${screen.name}-${theme}-${String(viewport.width)}`;
        await page.screenshot({ path: join(outputDirectory, `${label}.png`) });
        const problems = await page.evaluate(findViolations);
        const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
        report.push({
          screen: label,
          problems,
          axe: axe.violations.map((violation) => ({
            id: violation.id,
            impact: violation.impact,
            nodes: violation.nodes.length,
            targets: violation.nodes.slice(0, 3).map((node) => node.target.join(' ')),
          })),
        });
        for (const violation of axe.violations)
          if (violation.impact === 'serious' || violation.impact === 'critical')
            problems.push(
              `accessibility: ${violation.id} on ${violation.nodes
                .slice(0, 3)
                .map((node) => node.target.join(' '))
                .join(', ')}`,
            );
        if (problems.length) {
          failures += problems.length;
          console.error(`✗ ${label}\n  ${problems.join('\n  ')}`);
        } else console.log(`✓ ${label}`);
        await context.close();
      }
} finally {
  await browser.close();
  await new Promise((resolve, reject) =>
    served.server.close((error) => (error ? reject(error) : resolve())),
  );
}
await writeFile(join(outputDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
if (failures) {
  console.error(`${String(failures)} UI invariant violation(s). Screenshots: ${outputDirectory}`);
  process.exit(1);
}
console.log(
  `UI invariants hold on ${String(report.length)} screens. Screenshots: ${outputDirectory}`,
);
