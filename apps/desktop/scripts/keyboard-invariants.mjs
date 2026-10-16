import assert from 'node:assert/strict';

/** Reach every action by Tab; using locator.focus() would conceal broken tab order. */
async function reach(page, locator) {
  await locator.waitFor({ state: 'visible', timeout: 30_000 });
  for (let index = 0; index < 100; index++) {
    if (await locator.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(
    `Keyboard cannot reach ${(await locator.getAttribute('aria-label')) ?? (await locator.textContent())}`,
  );
}
async function activate(page, locator) {
  await reach(page, locator);
  await page.keyboard.press('Enter');
}
export async function keyboardJourneys(browser, url, options) {
  const context = await browser.newContext({ ...options, reducedMotion: 'reduce' });
  const page = await context.newPage();
  try {
    await page.goto(new URL('/onboarding', url).href);
    await page.getByRole('heading', { name: 'What will you use Ferry for?' }).waitFor();
    assert.equal(
      await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches),
      true,
    );
    for (let step = 0; step < 5; step++) {
      await activate(
        page,
        page.getByRole('button', {
          name: step === 4 ? 'Create key and continue' : 'Continue',
          exact: true,
        }),
      );
      await page
        .getByRole('heading', {
          name: [
            'Connect a provider',
            'Use Auto',
            'Check readiness',
            'Create a named key',
            'Connect and verify',
          ][step],
          exact: true,
        })
        .waitFor();
    }
    await activate(page, page.getByRole('button', { name: 'Send verification request' }));
    await page.getByText(/Fixture request completed/).waitFor();
    await activate(page, page.getByRole('button', { name: 'Finish setup', exact: true }));
    await page.getByRole('navigation', { name: 'Primary' }).waitFor();
    await page.goto(new URL('/gateway', url).href);
    await reach(page, page.getByRole('tab', { name: 'Overview', exact: true }));
    for (const label of ['Requests', 'Routing', 'Keys']) {
      await page.keyboard.press('ArrowRight');
      await page.waitForFunction(
        (name) => document.activeElement?.textContent?.trim() === name,
        label,
      );
    }
    assert.equal(
      await page
        .getByRole('tab', { name: 'Keys', exact: true })
        .evaluate((element) => element === document.activeElement),
      true,
    );
    await page.keyboard.press('Enter');
    const create = page.getByRole('button', { name: 'Create key', exact: true });
    await activate(page, create);
    const name = page.getByRole('textbox', { name: 'Name', exact: true });
    await reach(page, name);
    await page.keyboard.type('Keyboard fixture');
    // Close through Escape and verify the triggering control receives focus again.
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal(
      await create.evaluate((element) => element === document.activeElement),
      true,
      'Key dialog did not restore focus',
    );
    await activate(page, create);
    await reach(page, name);
    await page.keyboard.type('Keyboard fixture');
    await activate(
      page,
      page.getByRole('dialog').getByRole('button', { name: 'Create key', exact: true }),
    );
    await activate(page, page.getByRole('button', { name: 'Done', exact: true }));
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal(
      await create.evaluate((element) => element === document.activeElement),
      true,
      'Secret dialog did not restore focus',
    );
    await page.goto(new URL('/?speed=0', url).href);
    const composer = page.getByRole('textbox', { name: 'Message Ferry' });
    await reach(page, composer);
    await page.keyboard.type('Fix the flaky tests');
    await page.keyboard.press('Enter');
    const allow = page.getByRole('button', { name: 'Allow once', exact: true });
    await activate(page, allow);
    await allow.waitFor({ state: 'hidden' });
    const conversationUrl = page.url();
    const modelUsage = page.getByRole('button', { name: /^Model usage for / }).first();
    await activate(page, modelUsage);
    await page.getByRole('dialog', { name: 'Conversation usage' }).waitFor();
    assert.equal(page.url(), conversationUrl, 'Opening usage navigated away from the conversation');
    await page.keyboard.press('Escape');
    await page.getByRole('dialog', { name: 'Conversation usage' }).waitFor({ state: 'hidden' });
    // Dialog teardown restores focus asynchronously after its content is removed.
    await page.waitForFunction(
      (element) => element === document.activeElement,
      await modelUsage.elementHandle(),
      { timeout: 2000 },
    );
    assert.equal(
      await modelUsage.evaluate((element) => element === document.activeElement),
      true,
      'Conversation usage did not restore focus to its model icon',
    );
    // No endlessly running motion survives the reduced-motion preference.
    assert.equal(
      await page.evaluate(
        () =>
          document
            .getAnimations()
            .filter(
              (animation) =>
                animation.playState === 'running' &&
                animation.effect?.getTiming().iterations === Infinity,
            ).length,
      ),
      0,
    );
  } finally {
    await context.close();
  }
}
