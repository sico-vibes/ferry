export const name = 'light-contrast';

export async function run(page, { url, expect }) {
  await page.goto(new URL('/settings', url).href);
  await page.getByRole('radio', { name: 'Light' }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  for (const [route, canvas] of [
    ['/', '.home-canvas'],
    ['/s/session_1', '.session-canvas'],
    ['/settings', '.settings-page'],
  ]) {
    await page.goto(new URL(route, url).href);
    await page.locator(canvas).waitFor();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    const result = await page.evaluate(() => {
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
        count: surfaces.length,
        mismatches: surfaces.flatMap((surface) => {
          const utility = ['bg-card', 'bg-raised', 'bg-rail-tile-active'].find((name) =>
            surface.classList.contains(name),
          );
          if (!utility) return [];
          const token = `--${utility.replace('bg-', 'bg-')}`;
          const expected = normalized(`var(${token})`);
          const actual = getComputedStyle(surface).backgroundColor;
          return actual === expected ? [] : [`${utility}: ${actual} instead of ${expected}`];
        }),
      };
    });
    expect(result.count, `${route} should exercise themed surface utilities`).toBeGreaterThan(0);
    expect(result.mismatches, `${route} has surface utilities detached from light tokens`).toEqual(
      [],
    );
  }
}
