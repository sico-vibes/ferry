export const name = 'review';
export async function run(page, ctx) {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(ctx.url);
  await page.getByRole('navigation', { name: 'Primary' }).waitFor();
  await page.getByRole('textbox', { name: 'Message Ferry' }).fill('Delegate the adapter refactor');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByRole('button', { name: 'Allow once' }).waitFor({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Allow once' }).click();
  const review = page.getByRole('button', { name: 'Review diff' });
  await review.waitFor({ timeout: 20_000 });
  await review.click();
  await page.waitForURL(/\/review\//);
  await ctx.expect(page.locator('.v2-app-shell .canvas-slot.ferry-legacy-scope')).toHaveCount(0);
  await ctx.expect(page.getByRole('region', { name: 'Delegation review' })).toBeVisible();
  await ctx.expect(page.locator('.review-toolbar')).toBeInViewport();
  await ctx.expect(page.getByRole('button', { name: 'Back to session' })).toBeInViewport();
  await ctx.expect(page.getByText('Gate results')).toBeVisible();
  await ctx
    .expect(page.getByRole('navigation', { name: 'Changed files' }).getByRole('button').first())
    .toBeVisible();
  await ctx.expect(page.locator('.monaco-diff-editor')).toBeVisible({ timeout: 20_000 });
  if (pageErrors.some((message) => message.includes('initialization')))
    throw new Error(`Review Monaco initialization failed: ${pageErrors.join('; ')}`);
  await ctx.expect(page.getByRole('button', { name: 'Accept' })).toBeEnabled();
  await ctx.expect(page.getByRole('button', { name: 'Accept' })).toBeInViewport();
  await ctx.expect(page.getByRole('button', { name: 'Reject' })).toBeEnabled();
  await ctx.expect(page.getByRole('button', { name: 'Rework' })).toBeEnabled();
  await page.getByRole('button', { name: 'Accept' }).click();
  await page.waitForURL(/\/s\/[^/]+$/);
  await ctx.expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
  await ctx.expect(page.getByText('completed', { exact: true })).toBeVisible();
  const activeChat = page.locator('.v2-chat-row[data-active="true"]');
  await ctx.expect(activeChat).toBeVisible();
  await ctx.expect(activeChat.locator('[data-status="running"]')).toHaveCount(0);
}
