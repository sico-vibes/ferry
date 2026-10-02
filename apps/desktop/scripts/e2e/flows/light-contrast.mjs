export const name = 'light-contrast';

const v2Surfaces = {
  background: ['.ferry-ui', 'backgroundColor', '--background'],
  sidebar: ['.v2-sidebar', 'backgroundColor', '--sidebar'],
  composer: ['.v2-composer', 'backgroundColor', '--card'],
  send: ['.v2-send-button', 'backgroundColor', '--primary'],
  text: ['.ferry-ui', 'color', '--foreground'],
};

async function readV2Surfaces(page) {
  return page.evaluate((surfaces) => {
    const root = document.querySelector('.ferry-ui');
    if (!root) throw new Error('V2 app root was not rendered');
    return Object.fromEntries(
      Object.entries(surfaces).map(([name, [selector, property, token]]) => {
        const element = document.querySelector(selector);
        if (!element) throw new Error(`${selector} was not rendered`);
        const probe = document.createElement('span');
        probe.style[property] = `var(${token})`;
        root.append(probe);
        const expected = getComputedStyle(probe)[property];
        probe.remove();
        return [
          name,
          {
            actual: getComputedStyle(element)[property],
            token: expected,
          },
        ];
      }),
    );
  }, v2Surfaces);
}

export async function run(page, { url, expect }) {
  await page.goto(new URL('/settings', url).href);
  await page.getByRole('radio', { name: 'Dark' }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');

  const darkValues = {};
  for (const route of ['/', '/s/session_1']) {
    await page.goto(new URL(route, url).href);
    await page.getByRole('navigation', { name: 'Primary' }).waitFor();
    await page.getByRole('textbox', { name: 'Message Ferry' }).waitFor({ state: 'visible' });
    await page.locator('.v2-send-button').waitFor({ state: 'attached' });
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    darkValues[route] = await readV2Surfaces(page);
  }

  await page.goto(new URL('/settings', url).href);
  await page.getByRole('radio', { name: 'Light' }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');

  for (const [route, readyRole, readyName] of [
    ['/', 'heading', /^Good (morning|afternoon|evening)/],
    ['/s/session_1', 'textbox', 'Message Ferry'],
  ]) {
    await page.goto(new URL(route, url).href);
    await page.getByRole('navigation', { name: 'Primary' }).waitFor();
    await page.getByRole(readyRole, { name: readyName }).waitFor({ state: 'visible' });
    await page.getByRole('textbox', { name: 'Message Ferry' }).waitFor({ state: 'visible' });
    await page.locator('.v2-send-button').waitFor({ state: 'attached' });
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    const actual = await readV2Surfaces(page);
    const isV2Route = await page.locator('.v2-chat-route').count();
    expect(isV2Route, `${route} should render the v2 chat route`).toBe(1);

    for (const [surface, value] of Object.entries(actual)) {
      expect(
        value.actual,
        `${route} ${surface} should use its light ${v2Surfaces[surface][2]} token`,
      ).toBe(value.token);
      expect(value.actual, `${route} ${surface} should differ from its dark value`).not.toBe(
        darkValues[route][surface].actual,
      );
    }
  }

  for (const route of ['/settings', '/models', '/library']) {
    await page.goto(new URL(route, url).href);
    await page.getByRole('navigation', { name: 'Primary' }).waitFor();
    const legacy = await page.evaluate(() => {
      const shell = document.querySelector('.v2-legacy-route');
      const surfaces = Array.from(
        document.querySelectorAll('.bg-card, .bg-raised, .bg-rail-tile-active'),
      );
      const normalized = (value) => {
        const probe = document.createElement('span');
        probe.style.backgroundColor = value;
        document.body.append(probe);
        const color = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return color;
      };
      return {
        isLegacy: Boolean(shell),
        mismatches: surfaces.flatMap((surface) => {
          const utility = ['bg-card', 'bg-raised', 'bg-rail-tile-active'].find((name) =>
            surface.classList.contains(name),
          );
          if (!utility) return [];
          const expected = normalized(`var(--${utility})`);
          const actual = getComputedStyle(surface).backgroundColor;
          return actual === expected ? [] : [`${utility}: ${actual} instead of ${expected}`];
        }),
      };
    });
    expect(legacy.isLegacy, `${route} should use its expected surface`).toBe(route !== '/settings');
    expect(legacy.mismatches, `${route} has surface utilities detached from light tokens`).toEqual(
      [],
    );
  }
  // UI-3 removes the legacy block entirely.
}
