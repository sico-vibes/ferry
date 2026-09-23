import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDirectory = resolve(fileURLToPath(new URL('..', import.meta.url)));
const repositoryRoot = resolve(packageDirectory, '../..');
const buildDirectory = resolve(packageDirectory, 'build');
const screenshotDirectory = resolve(repositoryRoot, 'design/screenshots/gallery');
const packageManager = resolve(repositoryRoot, 'node_modules/pnpm/bin/pnpm.cjs');
const scaleFlag = process.argv.find((argument) => argument.startsWith('--scale'));
const scaleIndex = process.argv.indexOf('--scale');
const scaleValue = scaleIndex >= 0 ? process.argv[scaleIndex + 1] : scaleFlag?.split('=')[1];
const scale = Number(scaleValue ?? '1');

if (![1, 1.25, 1.5].includes(scale)) {
  throw new Error('Use --scale 1, --scale 1.25, or --scale 1.5.');
}

execFileSync(process.execPath, [packageManager, '--filter', '@ferry/ui', 'gallery:build'], {
  cwd: repositoryRoot,
  stdio: 'inherit',
});

const metadata = JSON.parse(await readFile(resolve(buildDirectory, 'meta.json'), 'utf8'));
const stories = Object.keys(metadata.stories ?? {});

if (stories.length === 0) {
  throw new Error('No story IDs found in Ladle build/meta.json.');
}

await mkdir(screenshotDirectory, { recursive: true });

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    const relativePath = decodeURIComponent(pathname).replace(/^\/+/, '');
    const requestedPath = resolve(buildDirectory, relativePath || 'index.html');
    const pathFromBuild = relative(buildDirectory, requestedPath);
    if (pathFromBuild.startsWith(`..${sep}`) || pathFromBuild === '..') {
      response.writeHead(403).end('Forbidden');
      return;
    }

    let filePath = requestedPath;
    try {
      if (!(await stat(filePath)).isFile()) filePath = resolve(buildDirectory, 'index.html');
    } catch {
      filePath = resolve(buildDirectory, 'index.html');
    }

    response.writeHead(200, {
      'content-type': mimeTypes[extname(filePath)] ?? 'application/octet-stream',
    });
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(500).end('Unable to serve gallery asset');
  }
});

await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const address = server.address();
if (address === null || typeof address === 'string')
  throw new Error('Gallery server did not bind.');

process.env.PLAYWRIGHT_BROWSERS_PATH = '0';
const { chromium } = await import('@playwright/test');
const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: scale,
  });
  for (const storyId of stories) {
    const storyUrl = `http://127.0.0.1:${address.port}/?story=${encodeURIComponent(storyId)}`;
    await page.goto(storyUrl, { waitUntil: 'networkidle' });
    await page.addStyleTag({
      content:
        '.ladle-aside,.ladle-addons,.ladle-controls{display:none!important}.ladle-main{width:100%;max-width:none;flex:1 1 auto}',
    });
    await page.screenshot({ path: resolve(screenshotDirectory, `${storyId}.png`), fullPage: true });
  }
} finally {
  await browser.close();
  await new Promise((resolveClose, rejectClose) =>
    server.close((error) => (error ? rejectClose(error) : resolveClose())),
  );
}

console.log(`Wrote ${stories.length} gallery screenshots to ${screenshotDirectory} at ${scale}x.`);
