import AxeBuilder from '@axe-core/playwright';

export const name = 'accessibility';

export async function run(page, { url, expect }) {
  const failures = [];
  const scan = async (route, state = '') => {
    await page.goto(new URL(route, url).href, { waitUntil: 'domcontentloaded' });
    await page.getByRole('navigation', { name: 'Primary' }).waitFor();
    if (state === 'palette') {
      await page.keyboard.press('Control+k');
      await page.getByRole('dialog').waitFor();
    } else if (state === 'model-picker') {
      await page.getByRole('button', { name: /Auto ·/ }).click();
      await page.getByRole('dialog').waitFor();
    }
    if (state) await page.waitForTimeout(250);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    const blocking = results.violations.filter((item) =>
      ['serious', 'critical'].includes(item.impact),
    );
    if (blocking.length) {
      failures.push(
        `${route}${state ? ` (${state})` : ''}: ${blocking.map((issue) => issue.id).join(', ')}`,
      );
      console.error(`axe ${route}${state ? ` (${state})` : ''}:`);
      for (const issue of blocking) {
        console.error(`${issue.impact} ${issue.id}: ${issue.help}`);
        for (const node of issue.nodes.slice(0, 10))
          console.error(`  ${node.target.join(', ')}: ${node.failureSummary}`);
        if (issue.nodes.length > 10)
          console.error(`  plus ${issue.nodes.length - 10} more affected nodes`);
      }
    }
  };

  for (const route of [
    '/',
    '/s/session_3',
    '/explore',
    '/explore/usage',
    '/library',
    '/settings',
    '/onboarding',
  ]) {
    await scan(route);
  }
  await scan('/', 'palette');
  await scan('/s/session_3', 'model-picker');
  await page.goto(new URL('/s/session_3', url).href, { waitUntil: 'domcontentloaded' });
  await page.getByRole('textbox', { name: 'Message Ferry' }).fill('Delegate a bounded refactor');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Allow once' }).waitFor();
  await page.getByRole('button', { name: 'Allow once' }).click();
  const review = page.getByRole('button', { name: 'Review diff' });
  await review.waitFor({ timeout: 15_000 });
  await review.click();
  await page.getByRole('region', { name: 'Delegation review' }).waitFor();
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const reviewViolations = results.violations.filter((item) =>
    ['serious', 'critical'].includes(item.impact),
  );
  if (reviewViolations.length)
    failures.push(`review: ${reviewViolations.map((item) => item.id).join(', ')}`);
  expect(failures.length, `Axe violations: ${failures.join('; ')}`).toBe(0);
}
