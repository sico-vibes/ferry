import { spawn, spawnSync } from 'node:child_process';
import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reviewAreas } from './review-areas.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDirectory, '..', '..', '..');
const area = process.argv[2];
if (!area || (area !== 'all' && !Object.hasOwn(reviewAreas, area)))
  throw new Error(`Usage: pnpm shots:review <${[...Object.keys(reviewAreas), 'all'].join('|')}>`);
const areas = area === 'all' ? Object.keys(reviewAreas) : [area];
const states = [...new Set(areas.flatMap((name) => reviewAreas[name].states))];
const baseUrl = 'http://127.0.0.1:5199';
const reachable = async () => {
  try {
    return (await fetch(baseUrl)).ok;
  } catch {
    return false;
  }
};
const killTree = (child) => {
  if (!child.pid) return;
  if (process.platform === 'win32')
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGTERM');
};
const preview = (await reachable())
  ? null
  : spawn('pnpm preview:web', { cwd: root, stdio: 'ignore', shell: true, windowsHide: true });
let previewReady = await reachable();
try {
  for (let attempt = 0; !previewReady && attempt < 60; attempt++) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    previewReady = await reachable();
  }
  if (!previewReady) throw new Error('Web preview did not become ready at http://127.0.0.1:5199');
  const env = {
    ...process.env,
    FERRY_SKIP_WEB_BUILD: '1',
    FERRY_E2E_URL: baseUrl,
    FERRY_SHOT_STATES: states.join(','),
    FERRY_PREVIEW: '1',
    FERRY_SHOTS_DIR: join(root, '.dev', 'review-source'),
    PLAYWRIGHT_BROWSERS_PATH: '0',
  };
  const shots = spawn('node', [join(scriptDirectory, 'shots-v2.mjs')], {
    cwd: root,
    env,
    stdio: 'inherit',
    windowsHide: true,
  });
  const code = await new Promise((resolvePromise, reject) => {
    shots.once('error', reject);
    shots.once('exit', (value) => resolvePromise(value ?? 1));
  });
  if (code !== 0) throw new Error(`Existing shots-v2 flow exited with code ${String(code)}`);
  for (const selected of areas) {
    const destination = join(root, '.dev', 'review', selected);
    await mkdir(destination, { recursive: true });
    const areaStates = reviewAreas[selected].states;
    const captures = [];
    for (const state of areaStates) {
      for (const theme of ['light', 'dark']) {
        for (const size of ['1440x900', '1024x680']) {
          const name = `${state}-${theme}-${size}.png`;
          await copyFile(join(root, '.dev', 'review-source', name), join(destination, name));
          captures.push({ name, state });
        }
      }
    }
    const info = reviewAreas[selected];
    const lines = [
      `# Visual review: ${selected}`,
      '',
      '## References',
      '',
      ...[...new Set(areaStates.map((state) => info.references?.[state] ?? info.reference))].map(
        (reference) => `- [${reference}](../../../${reference})`,
      ),
      '',
      info.note,
      '',
      '## Captures',
      '',
      ...captures.map(({ name, state }) => {
        const reference = info.references?.[state] ?? info.reference;
        return `- [${name}](./${name}) - state ${state}; compare with [${reference}](../../../${reference})`;
      }),
      '',
      '## Product principles checklist',
      '',
      '- [ ] Simple: consistent 4 px grid, one radius scale, controls never wrap or squash, labels left and controls right, aligned left edges.',
      '- [ ] No sparkle/star icons and no emoji; lucide icons only, chosen for meaning.',
      '- [ ] No native OS dialogs for in-app actions; themed AlertDialog/Dialog instead.',
      '- [ ] Separation by tone and spacing, hairlines only; light and dark both first-class.',
      '- [ ] Tooltips instant and theme-coloured; never OS-native title.',
      '- [ ] Information-dense screens use tables and compact lists, not big cards.',
      '',
    ];
    await writeFile(join(destination, 'REVIEW.md'), lines.join('\n'), 'utf8');
    console.log(`Wrote ${String(captures.length)} captures and REVIEW.md to ${destination}`);
  }
} finally {
  if (preview) killTree(preview);
}
