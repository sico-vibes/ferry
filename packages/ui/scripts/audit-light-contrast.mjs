import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = resolve(scriptDirectory, '..');
const repositoryRoot = resolve(packageDirectory, '../..');
const buildDirectory = resolve(packageDirectory, 'build');
const packageManager = resolve(repositoryRoot, 'node_modules/pnpm/bin/pnpm.cjs');
if (process.env.FERRY_AUDIT_SKIP_BUILD !== '1') {
  execFileSync(process.execPath, [packageManager, '--filter', '@ferry/ui', 'gallery:build'], {
    cwd: repositoryRoot,
    stdio: 'inherit',
  });
}
const metadata = JSON.parse(await readFile(resolve(buildDirectory, 'meta.json'), 'utf8'));
const stories = Object.keys(metadata.stories ?? {});
if (stories.length === 0) throw new Error('Ladle did not export any stories to audit.');

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
  const target = resolve(
    buildDirectory,
    decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html',
  );
  const local = relative(buildDirectory, target);
  if (local.startsWith(`..${sep}`) || local === '..') {
    response.writeHead(403).end();
    return;
  }
  let file = target;
  try {
    if (!(await stat(file)).isFile()) file = resolve(buildDirectory, 'index.html');
  } catch {
    file = resolve(buildDirectory, 'index.html');
  }
  const type =
    new Map([
      ['.css', 'text/css'],
      ['.html', 'text/html'],
      ['.js', 'text/javascript'],
      ['.json', 'application/json'],
      ['.png', 'image/png'],
      ['.svg', 'image/svg+xml'],
      ['.woff2', 'font/woff2'],
    ]).get(extname(file)) ?? 'application/octet-stream';
  response.writeHead(200, { 'content-type': `${type}; charset=utf-8` });
  createReadStream(file).pipe(response);
});
await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Could not start local story server.');
process.env.PLAYWRIGHT_BROWSERS_PATH = '0';
const { chromium } = await import('@playwright/test');
const browser = await chromium.launch({ headless: true });
const failures = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  for (const story of stories) {
    await page.goto(`http://127.0.0.1:${address.port}/?story=${encodeURIComponent(story)}`, {
      waitUntil: 'networkidle',
    });
    await page.waitForTimeout(80);
    const found = await page.evaluate(() => {
      const rgb = (value) => {
        const values = value.match(/[\d.]+/g)?.map(Number);
        if (!values || values.length < 3) return null;
        return { r: values[0], g: values[1], b: values[2], a: values[3] ?? 1 };
      };
      const composite = (front, back) => {
        const a = front.a + back.a * (1 - front.a);
        return {
          r: (front.r * front.a + back.r * back.a * (1 - front.a)) / a,
          g: (front.g * front.a + back.g * back.a * (1 - front.a)) / a,
          b: (front.b * front.a + back.b * back.a * (1 - front.a)) / a,
          a,
        };
      };
      const luminance = ({ r, g, b }) => {
        const channel = (value) => {
          const x = value / 255;
          return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
      };
      const contrast = (a, b) => {
        const x = luminance(a);
        const y = luminance(b);
        return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
      };
      const failures = [];
      const docs = [
        document,
        ...[...document.querySelectorAll('iframe')].flatMap((frame) => {
          try {
            return frame.contentDocument ? [frame.contentDocument] : [];
          } catch {
            return [];
          }
        }),
      ];
      for (const doc of docs) {
        if (!doc.documentElement) continue;
        doc.documentElement.dataset.theme = 'light';
        const bodyBackground = rgb(getComputedStyle(doc.body).backgroundColor);
        const base =
          bodyBackground && bodyBackground.a > 0
            ? bodyBackground
            : { r: 250, g: 251, b: 253, a: 1 };
        for (const element of doc.body.querySelectorAll('*')) {
          const directText = [...element.childNodes].some(
            (node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim(),
          );
          if (!directText) continue;
          const style = getComputedStyle(element);
          if (
            style.display === 'none' ||
            style.visibility === 'hidden' ||
            Number(style.opacity) === 0 ||
            Number.parseFloat(style.fontSize) === 0
          )
            continue;
          const foreground = rgb(style.color);
          if (!foreground || foreground.a === 0) continue;
          const ancestors = [];
          for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
            ancestors.push(ancestor);
            if (ancestor === doc.documentElement) break;
          }
          const opaqueIndex = ancestors.findIndex(
            (ancestor) => (rgb(getComputedStyle(ancestor).backgroundColor)?.a ?? 0) >= 1,
          );
          const solidLimit = opaqueIndex < 0 ? ancestors.length - 1 : opaqueIndex;
          let background = base;
          for (let index = solidLimit; index >= 0; index -= 1) {
            const ancestor = ancestors[index];
            const bg = rgb(getComputedStyle(ancestor).backgroundColor);
            if (bg && bg.a > 0) background = composite(bg, background);
          }
          const backgrounds = [background];
          const gradientBackgrounds = [];
          for (let index = 0; index <= solidLimit; index += 1) {
            const ancestor = ancestors[index];
            const image = getComputedStyle(ancestor).backgroundImage;
            if (!image.includes('gradient(')) continue;
            let under = base;
            for (let underIndex = ancestors.length - 1; underIndex > index; underIndex -= 1) {
              const underColor = rgb(getComputedStyle(ancestors[underIndex]).backgroundColor);
              if (underColor && underColor.a > 0) under = composite(underColor, under);
            }
            for (const token of image.match(/rgba?\([^)]*\)/g) ?? []) {
              const color = rgb(token);
              if (color) gradientBackgrounds.push(composite(color, under));
            }
          }
          if (gradientBackgrounds.length)
            backgrounds.splice(0, backgrounds.length, ...gradientBackgrounds);
          const ratio = Math.min(
            ...backgrounds.map((candidate) =>
              contrast(composite(foreground, candidate), candidate),
            ),
          );
          if (ratio < 4.5)
            failures.push(
              `${element.tagName.toLowerCase()} "${element.textContent.trim().replace(/\s+/g, ' ').slice(0, 36)}" ${ratio.toFixed(2)}:1 (text ${style.color}; background ${background.r.toFixed(0)},${background.g.toFixed(0)},${background.b.toFixed(0)})`,
            );
        }
      }
      return failures;
    });
    if (found.length) failures.push(...found.map((entry) => `${story}: ${entry}`));
  }
} finally {
  await browser.close();
  await new Promise((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
}
if (failures.length) {
  console.error(`Light contrast audit failed (${failures.length} pairs):\n${failures.join('\n')}`);
  process.exitCode = 1;
} else {
  console.log(
    `Light contrast audit passed: ${stories.length} gallery stories, all visible text pairs at least 4.5:1.`,
  );
}
