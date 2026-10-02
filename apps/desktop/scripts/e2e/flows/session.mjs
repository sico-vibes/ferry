export const name = 'session';
export const speed = 10;

export async function run(page, { url, expect }) {
  await page.setViewportSize({ width: 1280, height: 800 });
  const demoUrl = new URL(url);
  demoUrl.searchParams.set('demo', 'long');
  await page.goto(demoUrl.toString());
  const viewport = page.locator('.transcript-viewport');
  await viewport.waitFor({ state: 'visible' });
  await expect
    .poll(() => page.locator('.transcript-message[data-index="9999"]').count(), { timeout: 20_000 })
    .toBe(1);
  await expect
    .poll(() =>
      viewport.evaluate((element) => {
        const tail = element.querySelector('.transcript-message[data-index="9999"]');
        return tail
          ? Math.abs(tail.getBoundingClientRect().bottom - element.getBoundingClientRect().bottom)
          : Number.POSITIVE_INFINITY;
      }),
    )
    .toBeLessThanOrEqual(48);
  const startup = await viewport.evaluate((element) => {
    const tail = element.querySelector('.transcript-message[data-index="9999"]');
    return {
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      tailBottom: tail?.getBoundingClientRect().bottom ?? null,
      viewportBottom: element.getBoundingClientRect().bottom,
      tailHeight: tail?.getBoundingClientRect().height ?? null,
      tailIndex: Number(tail?.dataset.index ?? -1),
      spacerHeight: element.querySelector(':scope > div')?.getBoundingClientRect().height ?? null,
    };
  });
  console.log(`session M-03 startup: ${JSON.stringify(startup)}`);
  await viewport.evaluate((element) => {
    element.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -900 }));
    element.scrollTop = Math.max(0, element.scrollTop - 900);
  });
  await expect(viewport).toHaveAttribute('data-at-bottom', 'false');
  await expect(page.getByRole('button', { name: /Jump to latest/ })).toBeVisible();
  const before = await viewport.evaluate((element) => {
    const first = [...element.querySelectorAll('.transcript-message')].find(
      (message) => message.getBoundingClientRect().bottom > element.getBoundingClientRect().top,
    );
    return {
      scrollTop: element.scrollTop,
      index: Number(first?.dataset.index ?? -1),
      offset: first
        ? first.getBoundingClientRect().top - element.getBoundingClientRect().top
        : null,
    };
  });
  await expect(page.getByRole('button', { name: /Jump to latest, \d+ new/ })).toBeVisible();
  await expect
    .poll(async () => Number((await viewport.getAttribute('data-new-output-count')) ?? 0))
    .toBeGreaterThanOrEqual(2);
  const after = await viewport.evaluate((element) => {
    const first = [...element.querySelectorAll('.transcript-message')].find(
      (message) => message.getBoundingClientRect().bottom > element.getBoundingClientRect().top,
    );
    return {
      scrollTop: element.scrollTop,
      index: Number(first?.dataset.index ?? -1),
      offset: first
        ? first.getBoundingClientRect().top - element.getBoundingClientRect().top
        : null,
    };
  });
  console.log(
    `session M-01 anchor: ${JSON.stringify({ before, after, scrollTopDelta: after.scrollTop - before.scrollTop, offsetDelta: after.offset - before.offset })}`,
  );
  if (before.index !== after.index || Math.abs(after.offset - before.offset) > 1)
    throw new Error(`Streaming moved the reader anchor: ${JSON.stringify({ before, after })}`);

  await page.getByRole('button', { name: /Jump to latest/ }).click();
  await expect(page.getByRole('button', { name: /Jump to latest/ })).toHaveCount(0, {
    timeout: 5_000,
  });
  const jumped = await viewport.evaluate((element) => {
    const tail = element.querySelector('.transcript-message[data-index="9999"]');
    return {
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      tailVisible: Boolean(
        tail &&
        tail.getBoundingClientRect().bottom > element.getBoundingClientRect().top &&
        Math.abs(tail.getBoundingClientRect().bottom - element.getBoundingClientRect().bottom) <=
          48,
      ),
      tailBottomGap: tail
        ? element.getBoundingClientRect().bottom - tail.getBoundingClientRect().bottom
        : null,
    };
  });
  console.log(`session M-02/M-03 tail: ${JSON.stringify({ startup, jumped })}`);
  if (!jumped.tailVisible)
    throw new Error(`Jump to latest missed the tail: ${JSON.stringify(jumped)}`);

  const modelPicker = page.getByRole('button', { name: /^Auto · / }).first();
  await modelPicker.click();
  const modelDialog = page.getByRole('dialog', { name: 'Choose model' });
  await expect(modelDialog.getByText('Auto (recommended)')).toBeVisible();
  await modelDialog.getByText('Auto (recommended)').click();
  await expect(page.getByRole('button', { name: /Auto/ }).first()).toBeVisible();

  await expect(page.getByRole('button', { name: /^Auto · / }).first()).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
}
