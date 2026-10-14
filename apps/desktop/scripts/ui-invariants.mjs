// Layout invariants for the key screens, in both themes at 1024 and 1440 px wide:
// no horizontal overflow, no clipped button/badge/tab text, and click targets at least 24 px.
// Screenshots and an axe accessibility report go to apps/desktop/ui-invariants/ for review.
// Usage: node scripts/ui-invariants.mjs   (FERRY_SKIP_WEB_BUILD=1 to reuse out/web)
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveDirectory } from './static-server.mjs';
import { keyboardJourneys } from './keyboard-invariants.mjs';

if (process.env.FERRY_SKIP_WEB_BUILD !== '1') await import('./build-web.mjs');
process.env.PLAYWRIGHT_BROWSERS_PATH ??= '0';
const { chromium } = await import('@playwright/test');
const { default: AxeBuilder } = await import('@axe-core/playwright');

const packageDirectory = join(dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = join(packageDirectory, 'ui-invariants');
await mkdir(outputDirectory, { recursive: true });
const phaseShots = join(packageDirectory, '..', '..', '.dev', 'shots', 'g1-D');
await mkdir(phaseShots, { recursive: true });
const served = await serveDirectory(join(packageDirectory, 'out', 'web'));

const screens = [
  { name: 'home', path: '/' },
  { name: 'models', path: '/models' },
  { name: 'model-catalog', path: '/models/catalog' },
  { name: 'model-details', path: '/models/catalog', modelDetails: true },
  { name: 'provider-verification', path: '/models', integrationTooltip: true },
  { name: 'installed-cli-connections', path: '/models', inspectCliConnections: true },
  { name: 'cli-sign-in-instructions', path: '/models', cliSignIn: true },
  { name: 'provider-endpoint', path: '/models', endpoint: true },
  { name: 'model-picker', path: '/', modelPicker: true },
  { name: 'command-palette', path: '/', palette: true },
  { name: 'usage', path: '/models/usage' },
  { name: 'health', path: '/models/health' },
  { name: 'gateway', path: '/gateway' },
  ...['Requests', 'Routing', 'Keys', 'Usage & costs', 'Connect'].map((tab) => ({
    name: `gateway-${tab.toLowerCase().replaceAll(' & ', '-').replaceAll(' ', '-')}`,
    path: '/gateway',
    tab,
  })),
  ...Array.from({ length: 6 }, (_, step) => ({
    name: `onboarding-${String(step + 1)}`,
    path: '/onboarding',
    step,
  })),
  { name: 'onboarding-account', path: '/onboarding', step: 1, method: 'Account sign-in' },
  { name: 'onboarding-local', path: '/onboarding', step: 1, method: 'Local server' },
  { name: 'gateway-request-details', path: '/gateway', requestDetails: true },
  { name: 'gateway-optimized-preview', path: '/gateway', tab: 'Routing', providerCheck: true },
  { name: 'onboarding-paid-backup', path: '/onboarding', step: 2, paidBackup: true },
  { name: 'onboarding-paid-verification', path: '/onboarding', step: 5, paidBackup: true },
  { name: 'chat', path: '/?speed=0', openFirstChat: true },
  {
    name: 'conversation-model-usage',
    path: '/?speed=0',
    openFirstChat: true,
    conversationUsage: true,
  },
  ...['Plan', 'Changes', 'Terminal'].map((drawer) => ({
    name: `drawer-${drawer.toLowerCase()}`,
    path: '/?speed=0',
    openFirstChat: true,
    drawer,
  })),
  { name: 'settings-general', path: '/settings', section: 'General' },
  { name: 'settings-routing', path: '/settings', section: 'Routing' },
  { name: 'settings-providers', path: '/settings', section: 'Providers & keys' },
  { name: 'settings-permissions', path: '/settings', section: 'Permissions' },
  { name: 'settings-data', path: '/settings', section: 'Data & privacy' },
  { name: 'settings-cloud', path: '/settings', section: 'Storage & Cloud' },
  { name: 'settings-profiles', path: '/settings', section: 'Profiles' },
  ...[
    'Notifications',
    'Optimizers',
    'Delegation',
    'Gateway',
    'Integrations',
    'Shortcuts',
    'About',
  ].map((section) => ({ name: `settings-${section.toLowerCase()}`, path: '/settings', section })),
  { name: 'settings-routing-advanced', path: '/settings', section: 'Routing', advanced: true },
  {
    name: 'settings-optimizers-advanced',
    path: '/settings',
    section: 'Optimizers',
    advanced: true,
  },
  { name: 'providers-paid-checks', path: '/models', paidChecks: true },
  {
    name: 'settings-delegation-connections',
    path: '/settings',
    section: 'Delegation',
    openConnectionManager: true,
  },
  ...['About', 'Data & privacy'].map((section) => ({
    name: `settings-${section === 'About' ? 'about' : 'data'}-diagnostics`,
    path: '/settings',
    section,
    diagnostics: true,
  })),
  { name: 'review-missing', path: '/s/demo-session/review/demo-run' },
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
const cases = ['dark', 'light'].flatMap((theme) =>
  viewports.flatMap((viewport) =>
    [1, 1.25, 1.5].flatMap((deviceScaleFactor) =>
      screens.map((screen) => ({ theme, viewport, deviceScaleFactor, screen })),
    ),
  ),
);
async function checkScreen({ theme, viewport, deviceScaleFactor, screen }) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor,
    reducedMotion: 'reduce',
    colorScheme: theme === 'light' ? 'light' : 'dark',
  });
  const page = await context.newPage();
  await page.goto(
    new URL(`${screen.path}${screen.path.includes('?') ? '&' : '?'}theme=${theme}`, served.url)
      .href,
  );
  if (screen.step !== undefined) {
    await page
      .getByRole('heading', { name: 'What will you use Ferry for?', exact: true })
      .waitFor({ timeout: 30000 });
    const titles = [
      'What will you use Ferry for?',
      'Connect a provider',
      'Use Auto',
      'Check readiness',
      'Create a named key',
      'Connect and verify',
    ];
    for (let step = 0; step < screen.step; step++) {
      await page
        .getByRole('button', {
          name: step === 4 ? 'Create key and continue' : 'Continue',
          exact: true,
        })
        .click();
      await page
        .getByRole('heading', { name: titles[step + 1], exact: true })
        .waitFor({ timeout: 30000 });
      if (screen.paidBackup && screen.step > 2 && step + 1 === 2) {
        await page.getByRole('switch', { name: 'Enable paid backup' }).click();
        await page.getByRole('textbox', { name: 'Monthly spending limit (USD)' }).fill('5');
      }
    }
    if (screen.paidBackup && screen.step === 2) {
      await page.getByRole('switch', { name: 'Enable paid backup' }).click();
      await page.getByRole('textbox', { name: 'Monthly spending limit (USD)' }).fill('5');
    }
    if (screen.method) {
      await page.getByRole('combobox', { name: 'Connection method' }).click();
      await page.getByRole('option', { name: screen.method, exact: true }).click();
    }
    await page.evaluate(() => {
      for (const element of document.querySelectorAll(
        '.page-scroll-canvas,.onboarding-page,.onboarding-content',
      ))
        element.scrollTop = 0;
    });
  } else await page.locator('.v2-sidebar').first().waitFor({ timeout: 30_000 });
  if (screen.tab) await page.getByRole('tab', { name: screen.tab, exact: true }).click();
  if (screen.endpoint) {
    await page
      .locator('#provider-openai-compatible')
      .getByRole('button', { name: 'Manage key', exact: true })
      .click();
    await page.getByRole('textbox', { name: 'Provider base URL' }).fill('http://localhost:8080/v1');
  }
  if (screen.modelPicker) await page.locator('.v2-composer-chip[aria-controls]').click();
  if (screen.modelDetails) {
    await page.locator('.model-table-name-button').first().click();
    await page.locator('.model-table-details').waitFor();
  }
  if (screen.integrationTooltip) {
    await page
      .getByRole('img', { name: /^Verified integration\./ })
      .first()
      .hover();
    await page.getByRole('tooltip').waitFor();
  }
  if (screen.inspectCliConnections || screen.cliSignIn) {
    const connections = page.getByRole('region', { name: 'Installed CLIs', exact: true });
    await connections.getByRole('switch', { name: 'Use Codex CLI in Ferry' }).waitFor();
    await connections.scrollIntoViewIfNeeded();
    if (screen.cliSignIn) {
      await connections.getByRole('button', { name: 'Sign-in instructions' }).first().click();
      await page.getByRole('dialog', { name: 'Sign in to Codex CLI' }).waitFor();
    }
  }
  if (screen.palette) await page.keyboard.press('Control+k');
  if (screen.paidChecks) {
    await page.getByText('Paid checks', { exact: true }).click();
    await page.getByRole('button', { name: 'Check paid API providers' }).scrollIntoViewIfNeeded();
  }
  if (screen.providerCheck) {
    await page.getByRole('button', { name: 'Check free providers', exact: true }).click();
    await page
      .getByRole('heading', { name: 'Preview: Optimized for this device', exact: true })
      .waitFor();
    await page
      .getByRole('button', { name: 'Apply recommendations', exact: true })
      .scrollIntoViewIfNeeded();
  }
  if (screen.paidBackup && screen.step === 5) {
    await page.getByRole('button', { name: 'Send verification request' }).scrollIntoViewIfNeeded();
  }
  if (screen.requestDetails) {
    await page.getByRole('tab', { name: 'Keys', exact: true }).click();
    await page.getByRole('button', { name: 'Create key', exact: true }).click();
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Screenshot fixture');
    await page.getByRole('dialog').getByRole('button', { name: 'Create key', exact: true }).click();
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.getByRole('tab', { name: 'Connect', exact: true }).click();
    await page.getByRole('button', { name: 'Send verification request' }).click();
    await page.getByText(/Fixture request completed/).waitFor();
    await page.getByRole('tab', { name: 'Requests', exact: true }).click();
    await page.getByRole('button', { name: 'Screenshot fixture', exact: true }).click();
    await page.getByRole('heading', { name: 'Request details' }).waitFor();
  }
  if (screen.openFirstChat) {
    // The web build has no saved chats: start one and let the scripted reply play.
    const composer = page.getByRole('textbox').first();
    await composer.fill('Find and fix the flaky retry test, then run the suite.');
    await composer.press('Enter');
    await page.locator('.transcript-message').nth(1).waitFor({ timeout: 30_000 });
    await page.waitForTimeout(4_000);
  }
  if (screen.conversationUsage) {
    await page
      .getByRole('button', { name: /^Model usage for / })
      .first()
      .click();
    await page.getByRole('dialog', { name: 'Conversation usage' }).waitFor();
    await page
      .getByText('Loading conversation usage…', { exact: true })
      .waitFor({ state: 'hidden' });
  }
  if (screen.section) {
    await page.locator('.v2-settings-nav').waitFor({ timeout: 15_000 });
    await page.locator('.v2-settings-nav button', { hasText: screen.section }).first().click();
    if (screen.advanced)
      await page
        .locator('.v2-settings-content details > summary')
        .filter({ hasText: /^Advanced$/ })
        .first()
        .click();
    if (screen.openConnectionManager) {
      await page.getByRole('button', { name: 'Manage CLI connections', exact: true }).click();
      await page
        .getByRole('region', { name: 'Installed CLIs', exact: true })
        .scrollIntoViewIfNeeded();
    }
    if (screen.diagnostics) {
      const exportButton = page.getByRole('button', {
        name: 'Export sanitized diagnostics',
      });
      await exportButton.scrollIntoViewIfNeeded();
      await exportButton.click();
      await page.getByText(/Exported Ferry/).waitFor();
    }
  }
  if (screen.drawer) {
    await page.keyboard.press('Control+.');
    await page.getByRole('tab', { name: screen.drawer, exact: true }).click();
  }
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(600);
  const label = `${screen.name}-${theme}-${String(viewport.width)}-${deviceScaleFactor * 100}pct`;
  await page.screenshot({ path: join(outputDirectory, `${label}.png`) });
  await copyFile(join(outputDirectory, `${label}.png`), join(phaseShots, `${label}.png`));
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
try {
  // Isolated contexts permit a bounded three-worker matrix without sharing fixture state.
  let next = 0;
  await Promise.all(
    Array.from({ length: 3 }, async () => {
      while (next < cases.length) await checkScreen(cases[next++]);
    }),
  );
  for (const colorScheme of ['dark', 'light'])
    for (const viewport of viewports)
      for (const deviceScaleFactor of [1, 1.25, 1.5]) {
        await keyboardJourneys(browser, served.url, { colorScheme, viewport, deviceScaleFactor });
        console.log(
          `✓ keyboard journeys ${colorScheme} ${viewport.width} ${deviceScaleFactor * 100}%`,
        );
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
