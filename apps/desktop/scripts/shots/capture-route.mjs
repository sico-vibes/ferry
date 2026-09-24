export function captureRoute({
  path,
  heading,
  selector,
  file,
  role = 'heading',
  exact = false,
  action,
  beforeAction = false,
}) {
  return async (page, ctx) => {
    await page.goto(new URL(path, ctx.url).href);
    if (action && beforeAction) await action(page);
    if (selector) await page.locator(selector).waitFor();
    if (heading) await page.getByRole(role, { name: heading, exact }).waitFor();
    if (action && !beforeAction) await action(page);
    await ctx.capture(page, file);
  };
}
