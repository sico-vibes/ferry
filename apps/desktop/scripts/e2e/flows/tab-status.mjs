export const name = 'tab-status';
export const speed = 4;
export async function run(page, ctx) {
  await page.goto(ctx.url);
  await page.getByRole('navigation', { name: 'Primary' }).waitFor();
  const activeChatRow = () => page.locator('.v2-chat-row:has([aria-current="page"])');
  await page.getByRole('textbox', { name: 'Message Ferry' }).fill('Explain the router');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.waitForURL(/\/s\//);
  await ctx.expect(activeChatRow().locator('[data-status="running"]')).toBeVisible();

  await page.goto(ctx.url);
  await page.getByRole('textbox', { name: 'Message Ferry' }).fill('Fix the flaky tests');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByRole('button', { name: 'Allow once' }).waitFor();
  await ctx.expect(activeChatRow().locator('[data-status="awaiting_approval"]')).toBeVisible();
  await page.getByRole('button', { name: 'Allow once' }).click();
}
