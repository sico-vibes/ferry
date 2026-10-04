import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveDirectory } from './static-server.mjs';

if (process.env.FERRY_SKIP_WEB_BUILD !== '1') await import('./build-web.mjs');

process.env.PLAYWRIGHT_BROWSERS_PATH = '0';
const { chromium } = await import('@playwright/test');
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = join(scriptDirectory, '..');
const outputDirectory = process.env.FERRY_SHOTS_DIR
  ? resolve(process.env.FERRY_SHOTS_DIR)
  : join(packageDirectory, '..', '..', 'design', 'screenshots', 'v2');
await mkdir(outputDirectory, { recursive: true });
const hostedUrl = process.env.FERRY_E2E_URL;
const served = hostedUrl ? null : await serveDirectory(join(packageDirectory, 'out', 'web'));
const baseUrl = hostedUrl ?? served?.url;
if (!baseUrl) throw new Error('Screenshot server URL was not provided');
const viewports = [
  { width: 1440, height: 900 },
  { width: 1024, height: 680 },
];
const themes = ['dark', 'light'];
const states = [
  'home-idle',
  'user-menu-open',
  'user-menu-theme-open',
  'sidebar-tooltip',
  'titlebar-collapsed',
  'confirm-dialog',
  'session-idle',
  'session-activity-collapsed',
  'session-activity-expanded',
  'session-approval-pending',
  'session-interrupted',
  'about-dialog',
  'session-streaming',
  'approval-pending',
  'drawer-open',
  'library-list',
  'library-detail',
  'library-instructions',
  'library-permissions',
  'models-providers',
  'models-catalog',
  'models-usage',
  'model-picker-open',
  'model-picker-hover',
  'settings-general',
  'settings-scrolled',
  'settings-profiles',
  'settings-providers',
  'settings-provider-key-dialog',
  'settings-routing',
  'settings-optimizers',
  'settings-delegation',
  'settings-permissions',
  'settings-gateway',
  'settings-data-privacy',
  'settings-shortcuts',
  'settings-about',
  'onboarding-welcome',
  'onboarding-provider',
  'onboarding-folder',
  'drawer-changes',
  'drawer-terminal',
  'drawer-agent-log',
  'command-palette',
  'review',
];
const filename = (state, theme, viewport) =>
  `${state}-${theme}-${viewport.width}x${viewport.height}.png`;
const requestedStates = process.env.FERRY_SHOT_STATES?.split(',')
  .map((state) => state.trim())
  .filter(Boolean);
const statesToCapture = requestedStates
  ? states.filter((state) => requestedStates.includes(state))
  : states;
if (requestedStates?.some((state) => !states.includes(state)))
  throw new Error(`Unknown screenshot state in FERRY_SHOT_STATES: ${requestedStates.join(', ')}`);
const errors = [];

async function selectTheme(page, theme) {
  await page.getByRole('button', { name: 'User menu' }).click();
  await page.getByRole('menuitem', { name: 'Theme', exact: true }).hover();
  await page.getByRole('menuitemradio', { name: theme === 'dark' ? 'Dark' : 'Light' }).click();
  await page.getByRole('textbox', { name: 'Message Ferry' }).waitFor();
  await page.evaluate(() => {
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement) activeElement.blur();
  });
  await page.evaluate(() => document.fonts.ready);
}

async function hidePreviewChrome(page) {
  await page.addStyleTag({
    content: '.web-preview-toggle,.web-preview-panel{display:none!important}',
  });
}

async function configureTheme(page, theme) {
  await page.goto(baseUrl);
  await page.locator('.v2-app-shell').waitFor();
  await hidePreviewChrome(page);
  await selectTheme(page, theme);
}

// Navigate through the sidebar so the seeded transcript uses the mounted mock
// client and keeps the theme selected by configureTheme.
async function openSeededSession(page) {
  await page.locator('.v2-chat-open').filter({ hasText: 'Fix flaky tests' }).click();
  await page.locator('.transcript-viewport[data-session-status="idle"]').waitFor();
}

async function captureState(browser, state, theme, viewport) {
  const label = `${state}-${theme}-${viewport.width}x${viewport.height}`;
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    if (process.env.FERRY_PREVIEW === '1')
      await page.addInitScript(() => {
        const url = new URL(location.href);
        url.searchParams.set('preview', 'web');
        if (!url.searchParams.has('scenario')) url.searchParams.set('scenario', 'busy');
        if (!url.searchParams.has('size'))
          url.searchParams.set(
            'size',
            `${String(window.innerWidth)}x${String(window.innerHeight)}`,
          );
        history.replaceState(null, '', url);
      });
    await configureTheme(page, theme);

    if (state.startsWith('library-')) {
      await page.goto(new URL('/library', baseUrl).href);
      await page.locator('.v2-library-header').waitFor();
      if (state !== 'library-list') {
        await page.locator('.v2-library-project-link').first().click();
        const tab =
          state === 'library-instructions'
            ? 'Instructions'
            : state === 'library-permissions'
              ? 'Permissions'
              : 'Sessions';
        await page.getByRole('tab', { name: tab, exact: true }).click();
      }
    } else if (state === 'home-idle' || state === 'command-palette') {
      await page.getByRole('textbox', { name: 'Message Ferry' }).focus();
      if (state === 'command-palette') {
        await page.keyboard.press('Control+k');
        await page.getByRole('dialog', { name: 'Command palette' }).waitFor();
      }
    } else if (state === 'user-menu-open') {
      await page.getByRole('button', { name: 'User menu', exact: true }).click();
      await page.getByRole('menu').waitFor();
    } else if (state === 'user-menu-theme-open') {
      await page.getByRole('button', { name: 'User menu', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Theme', exact: true }).hover();
      const systemTheme = page.getByRole('menuitemradio', { name: 'System', exact: true });
      await systemTheme.waitFor();
      if (!(await systemTheme.isVisible())) throw new Error('Theme submenu is not visible.');
    } else if (state === 'sidebar-tooltip') {
      await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
      const firstNavItem = page.locator('.v2-primary-nav button').first();
      await firstNavItem.hover();
      await page.getByRole('tooltip').waitFor();
    } else if (state === 'titlebar-collapsed') {
      await openSeededSession(page);
      await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
      await page.locator('.v2-app-shell.left-is-collapsed').waitFor();
      await page.waitForFunction(() => {
        const sidebar = document.querySelector('.v2-sidebar');
        return sidebar && Math.abs(sidebar.getBoundingClientRect().width - 64) < 0.5;
      });
    } else if (state === 'confirm-dialog') {
      await openSeededSession(page);
      await page.getByRole('button', { name: 'More session actions', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Delete session' }).click();
      await page.getByRole('alertdialog', { name: 'Delete chat?' }).waitFor();
    } else if (state.startsWith('models-')) {
      const route =
        state === 'models-usage'
          ? '/models/usage'
          : state === 'models-catalog'
            ? '/models/catalog'
            : '/models';
      const tab =
        state === 'models-usage' ? 'Usage' : state === 'models-catalog' ? 'Models' : 'Providers';
      await page.goto(new URL(route, baseUrl).href);
      await page.getByRole('heading', { name: 'Models', exact: true }).waitFor();
      await page.getByRole('tab', { name: tab, exact: true }).waitFor();
    } else if (state === 'model-picker-open' || state === 'model-picker-hover') {
      await openSeededSession(page);
      await page.getByRole('button', { name: /Auto/ }).click();
      const picker = page.getByRole('dialog', { name: 'Choose model' });
      await picker.waitFor();
      if (state === 'model-picker-hover') {
        const candidate = picker.locator('.model-candidate').last();
        await candidate.waitFor();
        await candidate.hover();
      }
    } else if (state.startsWith('settings-')) {
      const section =
        state === 'settings-scrolled' || state === 'settings-provider-key-dialog'
          ? 'Providers & keys'
          : {
              'settings-general': 'General',
              'settings-profiles': 'Profiles',
              'settings-providers': 'Providers & keys',
              'settings-routing': 'Routing',
              'settings-optimizers': 'Optimizers',
              'settings-delegation': 'Delegation',
              'settings-permissions': 'Permissions',
              'settings-gateway': 'Gateway',
              'settings-data-privacy': 'Data & privacy',
              'settings-shortcuts': 'Shortcuts',
              'settings-about': 'About',
            }[state];
      await page.goto(new URL('/settings', baseUrl).href);
      await page.getByRole('navigation', { name: 'Settings sections' }).waitFor();
      await page.getByRole('button', { name: section, exact: true }).click();
      if (state === 'settings-scrolled') {
        const content = page.locator('.v2-settings-content');
        await content.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
        await page.waitForFunction(
          () => document.querySelector('.v2-settings-content')?.scrollTop > 0,
        );
      } else if (state === 'settings-provider-key-dialog') {
        await page.evaluate(async () => {
          const raw = localStorage.getItem('ferry.mock.v1');
          if (!raw) throw new Error('Persisted mock fixture is unavailable');
          const persisted = JSON.parse(raw);
          const provider = persisted.data?.providers?.find((item) => item.id === 'openai');
          if (!provider) throw new Error('OpenAI mock provider is unavailable');
          provider.keyStatus = 'valid';
          provider.keyCount = 2;
          provider.enabled = true;
          persisted.data.providerKeys = [
            [
              'openai',
              [
                {
                  id: '1',
                  providerId: 'openai',
                  label: 'Primary project key',
                  order: 0,
                  enabled: true,
                  status: 'ok',
                  lastFour: '4d21',
                  usageToday: { requests: 18, tokens: 12400 },
                  lastError: null,
                  cooldownUntil: null,
                },
                {
                  id: '2',
                  providerId: 'openai',
                  label: 'Project key',
                  order: 1,
                  enabled: false,
                  status: 'disabled',
                  lastFour: 'b738',
                  usageToday: { requests: 7, tokens: 5200 },
                  lastError: 'Paused manually',
                  cooldownUntil: null,
                },
              ],
            ],
          ];
          localStorage.setItem('ferry.mock.v1', JSON.stringify(persisted));
        });
        await page.reload();
        await page.getByRole('navigation', { name: 'Settings sections' }).waitFor();
        await page.getByRole('button', { name: 'Providers & keys', exact: true }).click();
        const providerRow = page.locator('.provider-key-row').filter({ hasText: 'OpenAI API' });
        await providerRow.getByRole('button', { name: 'Manage key', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'Manage OpenAI API key', exact: true });
        await dialog.waitFor();
        const savedKeys = dialog.getByRole('region', { name: 'Saved provider keys' });
        await savedKeys.waitFor();
        await dialog.getByText('Project key (ending b738)', { exact: true }).waitFor();
        await savedKeys.getByText('Healthy', { exact: true }).waitFor();
        await savedKeys.getByText('Disabled', { exact: true }).waitFor();
        await savedKeys.getByText('Paused manually', { exact: true }).waitFor();
        const usageLines = await page.evaluate(() => {
          const format = new Intl.NumberFormat();
          return [
            `${format.format(18)} requests / ${format.format(12400)} tokens today`,
            `${format.format(7)} requests / ${format.format(5200)} tokens today`,
          ];
        });
        for (const usageLine of usageLines)
          await savedKeys.getByText(usageLine, { exact: true }).waitFor();
        await dialog.getByRole('region', { name: 'Provider routing' }).waitFor();
      }
    } else if (state.startsWith('onboarding-')) {
      await page.goto(new URL('/settings', baseUrl).href);
      await page.getByRole('button', { name: 'Run onboarding again' }).click();
      await page.locator('.v2-onboarding-shell').waitFor();
      if (state === 'onboarding-provider') {
        await page.getByRole('button', { name: 'Continue', exact: true }).click();
      } else if (state === 'onboarding-folder') {
        await page.getByRole('button', { name: 'Continue', exact: true }).click();
        await page.getByRole('button', { name: 'Continue', exact: true }).click();
      }
    } else if (
      state === 'session-activity-collapsed' ||
      state === 'session-activity-expanded' ||
      state === 'session-approval-pending'
    ) {
      await page.getByRole('textbox', { name: 'Message Ferry' }).fill('Fix flaky tests');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await page.waitForURL(/\/s\//);
      if (state === 'session-approval-pending') {
        await page.getByRole('button', { name: 'Allow once', exact: true }).waitFor();
      } else {
        const activity = page.getByRole('button', { name: /Working|Worked for/ });
        await activity.waitFor();
        if (state === 'session-activity-expanded') await activity.click();
      }
    } else if (state === 'session-idle' || state === 'drawer-open') {
      await openSeededSession(page);
      if (state === 'drawer-open') {
        await page.getByRole('button', { name: 'Toggle drawer' }).click();
        await page.getByRole('tablist', { name: 'Session drawer tabs' }).waitFor();
      }
    } else if (state === 'session-interrupted') {
      const interruptedUrl = new URL(baseUrl);
      interruptedUrl.searchParams.set('scenario', 'errors');
      interruptedUrl.searchParams.set('route', '/s/session_3');
      interruptedUrl.searchParams.set('theme', theme);
      await page.goto(interruptedUrl.href);
      await page.locator('.session-resume-banner').waitFor();
    } else if (state === 'about-dialog') {
      await page.getByRole('button', { name: 'User menu', exact: true }).click();
      await page.getByRole('menuitem', { name: 'About / changelog', exact: true }).click();
      await page.getByRole('dialog', { name: 'About Ferry', exact: true }).waitFor();
    } else if (state.startsWith('drawer-')) {
      await openSeededSession(page);
      await page.getByRole('button', { name: 'Toggle drawer' }).click();
      const tabs = page.getByRole('tablist', { name: 'Session drawer tabs' });
      await tabs.waitFor();
      if (state !== 'drawer-open') {
        await tabs
          .getByRole('tab', {
            name: state === 'drawer-changes' ? 'Changes' : 'Terminal',
            exact: true,
          })
          .click();
      }
      if (state === 'drawer-agent-log') {
        await page.getByRole('radio', { name: 'Agent log' }).click();
        await page.getByLabel('Agent log').waitFor();
      } else if (state === 'drawer-terminal') {
        await page.locator('.terminal-host').waitFor();
      } else if (state === 'drawer-changes') {
        await tabs.getByRole('tab', { name: 'Changes', exact: true }).waitFor();
      }
    } else if (state === 'review') {
      await page
        .getByRole('textbox', { name: 'Message Ferry' })
        .fill('Delegate the adapter refactor');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await page.getByRole('button', { name: 'Allow once', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Allow once', exact: true }).click();
      const activity = page.getByRole('button', { name: /Working|Worked for/ }).last();
      await activity.waitFor();
      if ((await activity.getAttribute('aria-expanded')) === 'false') await activity.click();
      await page
        .getByRole('button', { name: 'Review diff', exact: true })
        .waitFor({ timeout: 30_000 });
      await page.getByRole('button', { name: 'Review diff', exact: true }).click();
      await page.locator('.review-canvas').waitFor();
      await page.locator('.monaco-diff-editor').waitFor({ timeout: 30_000 });
    } else {
      const speed = state === 'session-streaming' ? 8 : 1;
      await page.goto(new URL(`/?speed=${String(speed)}`, baseUrl).href);
      await page.locator('.v2-app-shell').waitFor();
      await selectTheme(page, theme);
      await page.getByRole('textbox', { name: 'Message Ferry' }).fill('Fix flaky tests');
      await page.getByRole('button', { name: 'Send' }).click();
      await page.waitForURL(/\/s\//);
      if (state === 'session-streaming') {
        const activity = page.getByRole('button', { name: /Working|Worked for/ }).last();
        await activity.waitFor();
        if ((await activity.getAttribute('aria-expanded')) === 'false') await activity.click();
        await page.getByText('Bound retry delay and add jitter', { exact: true }).waitFor();
        const thinking = page.getByRole('button', { name: 'Thinking' });
        if (await thinking.count()) await thinking.click();
        await page.getByText(/The flaky assertion comes from unbounded input/i).waitFor();
      } else {
        await page.getByRole('button', { name: 'Allow once' }).waitFor();
      }
    }

    if (
      state !== 'model-picker-hover' &&
      state !== 'sidebar-tooltip' &&
      state !== 'user-menu-theme-open'
    )
      await page.mouse.move(0, 0);
    await hidePreviewChrome(page);
    if (state === 'titlebar-collapsed') {
      await page.waitForFunction(() => {
        const root = document.querySelector('.v2-app-shell');
        const sidebar = document.querySelector('.v2-sidebar');
        return Boolean(
          root?.classList.contains('left-is-collapsed') &&
          sidebar?.classList.contains('is-collapsed') &&
          Math.abs((sidebar?.getBoundingClientRect().width ?? 0) - 64) < 0.5,
        );
      });
    }
    if (state === 'user-menu-theme-open') {
      const systemTheme = page.getByRole('menuitemradio', { name: 'System', exact: true });
      if (!(await systemTheme.isVisible())) throw new Error('Theme submenu closed before capture.');
    }

    await page.screenshot({ path: join(outputDirectory, filename(state, theme, viewport)) });
    console.log(`Captured ${label}`);
  } catch (error) {
    errors.push(label);
    console.error(`Failed ${label}: ${error instanceof Error ? error.stack : String(error)}`);
  } finally {
    await context.close();
  }
}

try {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const viewport of viewports) {
      for (const theme of themes) {
        for (const state of statesToCapture) {
          await captureState(browser, state, theme, viewport);
        }
      }
    }
  } finally {
    await browser.close();
  }
} finally {
  if (served)
    await new Promise((resolve, reject) =>
      served.server.close((error) => (error ? reject(error) : resolve())),
    );
}

if (errors.length > 0) {
  console.error(
    `Failed to capture ${String(errors.length)} screenshot state(s): ${errors.join(', ')}`,
  );
  process.exitCode = 1;
}
