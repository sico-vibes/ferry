export const name = 'inline-approval';
export async function run(page, ctx) {
  await page.goto(ctx.url);
  await page.getByRole('navigation', { name: 'Primary' }).waitFor();
  await page.getByRole('textbox', { name: 'Message Ferry' }).fill('Fix the flaky tests');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByRole('button', { name: 'Allow once' }).waitFor({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Allow once' }).click();
  const activity = page.getByRole('button', { name: /Worked for|Working/ }).last();
  await activity.click();
  await ctx.expect(page.getByText(/Allowed:/i)).toBeVisible({ timeout: 15_000 });
}
