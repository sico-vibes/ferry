export const name = 'chain-labels';

export async function run(page, ctx) {
  await page.goto(new URL('/explore', ctx.url).href);
  await page.locator('.app-shell').waitFor();
  await page.getByRole('heading', { name: 'Providers' }).waitFor();
  await ctx.capture(page, 'provider-cards-data-use.png');

  await page.goto(new URL('/', ctx.url).href);
  await page.getByRole('navigation', { name: 'Primary' }).waitFor();
  await page.getByRole('button', { name: 'New Chat' }).first().click();
  await page.waitForURL(/\/s\//);
  const modelButton = page.getByRole('button', { name: /Auto ·/ });
  await modelButton.waitFor({ timeout: 15_000 });
  await modelButton.click();
  await page.getByRole('dialog', { name: 'Choose model' }).waitFor();
  await ctx.capture(page, 'model-picker-data-use.png');
  await page.keyboard.press('Escape');

  await page.evaluate(() => {
    const card = document.createElement('section');
    card.className = 'session-error-card';
    card.setAttribute('role', 'alert');
    card.style.position = 'absolute';
    card.style.bottom = '24px';
    card.style.left = '50%';
    card.style.transform = 'translateX(-50%)';
    card.style.width = 'min(680px, 80vw)';
    card.style.zIndex = '1000';
    card.innerHTML = `<div class="session-error-summary"><p>All free candidates exhausted for plan. Next free capacity: Groq in 12 min. Wait or add a provider.</p></div><div class="session-error-actions"><button>Wait</button><button>Add provider</button></div><details class="session-error-details" open><summary>Details · 2 attempts</summary><ul><li><strong>groq/openai/gpt-oss-120b</strong><span>groq · rate_limit · 429 · 84 ms</span></li><li><strong>nvidia/openai/gpt-oss-120b</strong><span>nvidia · server · 503 · 132 ms</span></li></ul></details>`;
    document.querySelector('.transcript-viewport')?.append(card);
    card.scrollIntoView({ block: 'end' });
  });
  await ctx.capture(page, 'all-candidates-exhausted.png');
}
