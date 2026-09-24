export const name = 'hit-targets';

export async function run(page, { url, expect }) {
  const routes = ['/', '/s/session_1', '/settings'];
  for (const route of routes) {
    await page.goto(new URL(route, url).href);
    await page.locator('.app-shell').waitFor();
    const undersized = await page.evaluate(() => {
      const selector =
        'a[href],button,input,select,textarea,summary,[role="button"],[role="tab"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="option"],[role="checkbox"],[role="switch"],[role="link"],[role="radio"],[contenteditable="true"],[tabindex]:not([tabindex="-1"])';
      return Array.from(document.querySelectorAll(selector))
        .filter((element) => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return (
            !element.hasAttribute('disabled') &&
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            Number(style.opacity) !== 0 &&
            rect.width > 0 &&
            rect.height > 0 &&
            (rect.width < 28 || rect.height < 28)
          );
        })
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return `${element.getAttribute('aria-label') || element.textContent?.trim() || element.tagName}: ${Math.round(rect.width)}x${Math.round(rect.height)}`;
        });
    });
    expect(
      undersized,
      `${route} has interactive targets below 28x28: ${undersized.join('; ')}`,
    ).toEqual([]);
  }
}
