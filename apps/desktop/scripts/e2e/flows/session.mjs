export const name = 'session';

export async function run(page, { url, expect }) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${url}/?demo=long`);
  const viewport = page.locator('.transcript-viewport');
  await viewport.waitFor({ state: 'visible' });
  await expect
    .poll(() => page.locator('.transcript-message[data-index="999"]').count(), { timeout: 20_000 })
    .toBe(1);
  const startup = await viewport.evaluate((element) => {
    const tail = element.querySelector('.transcript-message[data-index="999"]');
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
  await expect
    .poll(() =>
      viewport.evaluate(
        (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
      ),
    )
    .toBeLessThanOrEqual(48);
  await viewport.hover();
  await page.mouse.wheel(0, -900);
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
  await page.waitForTimeout(500);
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
    const tail = element.querySelector('.transcript-message[data-index="999"]');
    return {
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      tailVisible: Boolean(
        tail && tail.getBoundingClientRect().bottom <= element.getBoundingClientRect().bottom + 48,
      ),
      tailBottomGap: tail
        ? element.getBoundingClientRect().bottom - tail.getBoundingClientRect().bottom
        : null,
    };
  });
  console.log(`session M-02/M-03 tail: ${JSON.stringify({ startup, jumped })}`);
  if (!jumped.tailVisible)
    throw new Error(`Jump to latest missed the tail: ${JSON.stringify(jumped)}`);

  const profile = page.locator('.session-canvas').getByRole('button', { name: /Best Available/ });
  await profile.click();
  await page.getByRole('menuitem', { name: 'Auto-Free' }).click();
  await expect(
    page.locator('.session-canvas').getByRole('button', { name: /Auto-Free/ }),
  ).toBeVisible();

  const handle = page.getByRole('separator', { name: 'Resize right panel' });
  const box = await handle.boundingBox();
  if (!box) throw new Error('Right panel resize handle is missing');
  await page.mouse.move(box.x + box.width / 2, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 260, box.y + 100);
  await page.mouse.up();
  await expect.poll(() => handle.getAttribute('aria-valuenow')).toBe('560');
  const toolbarModel = page.locator('.session-toolbar-primary > .relative:first-child > button');
  await expect(toolbarModel).toBeVisible();
  const modelHeight = await toolbarModel.evaluate(
    (element) => element.getBoundingClientRect().height,
  );
  if (modelHeight > 36)
    throw new Error(`Model selector wrapped at narrow center width (${modelHeight}px)`);
}
