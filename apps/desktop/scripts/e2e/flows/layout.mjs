export const name = 'layout';
export async function run(page, ctx) {
  await page.goto(ctx.url);
  await page.getByRole('button', { name: 'Collapse sidebar' }).click();
  await page.getByRole('button', { name: 'Show sidebar' }).waitFor();
  await page.getByRole('button', { name: 'Collapse right panel' }).click();
  await page.getByRole('button', { name: 'Show panel' }).waitFor();
  await page.getByRole('button', { name: 'Show sidebar' }).click();
  await page.getByRole('button', { name: 'Show panel' }).click();
}
