export const name = 'ui-shell';

export async function run(page, ctx) {
  await page.goto(ctx.url);
  await page.getByRole('textbox', { name: 'Message Ferry' }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  await ctx.capture(page, 'ui-shell-home.png');
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('radio', { name: 'Always show hero' }).click();
  await page.waitForFunction(() => Boolean(localStorage.getItem('ferry.mock.v1')));

  const seeded = await page.evaluate(() => {
    const raw = localStorage.getItem('ferry.mock.v1');
    if (!raw) return { ok: false, reason: `storage keys: ${Object.keys(localStorage).join(', ')}` };
    const persisted = JSON.parse(raw);
    const state = persisted.data;
    if (!Array.isArray(state.messages))
      return { ok: false, reason: `messages type: ${typeof state.messages}` };
    const entry = state.messages.find(([sessionId]) => sessionId === 'session_3');
    if (!entry)
      return { ok: false, reason: `session ids: ${state.messages.map(([id]) => id).join(', ')}` };
    const [, rows] = entry;
    rows.push({
      id: 'message_ui_shell_error',
      sessionId: 'session_3',
      role: 'assistant',
      createdAt: new Date().toISOString(),
      modelRef: 'nvidia/nemotron-3-ultra',
      parts: [
        {
          type: 'error',
          id: 'part_ui_shell_error',
          kind: 'provider',
          message:
            'Routing stopped after repeated model handoffs. Choose a model with available capacity or retry.',
        },
      ],
    });
    localStorage.setItem('ferry.mock.v1', JSON.stringify(persisted));
    return { ok: true, reason: '' };
  });
  if (!seeded.ok)
    throw new Error(`Could not seed the session error screenshot fixture: ${seeded.reason}`);

  await page.goto(new URL('/s/session_3', ctx.url).href);
  await page.locator('.transcript-viewport').waitFor({ state: 'attached' });
  await page.locator('.transcript-viewport').evaluate((element) => {
    element.style.visibility = 'visible';
    element.scrollTop = element.scrollHeight;
  });
  await page.locator('button[aria-label^="Model handoff:"]').waitFor({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Retry' }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  await ctx.capture(page, 'ui-shell-session-error-handoffs.png');

  await page.getByRole('button', { name: /Auto ·/ }).click();
  await page.getByRole('dialog', { name: 'Choose model' }).waitFor();
  await ctx.capture(page, 'ui-shell-model-picker.png');
  await page.keyboard.press('Escape');

  await page.goto(ctx.url);
  await page.getByRole('button', { name: 'Configuration' }).click();
  await page.getByRole('dialog', { name: 'Configuration' }).waitFor();
  await ctx.capture(page, 'ui-shell-configuration.png');
}
