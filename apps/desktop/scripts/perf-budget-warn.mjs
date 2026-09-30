import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const packageRoot = resolve(import.meta.dirname, '..');
const root = resolve(packageRoot, '../..');
const budgets = JSON.parse(
  await readFile(resolve(packageRoot, 'scripts/perf-budgets.json'), 'utf8'),
);
const resultPath = resolve(root, 'docs/perf-results.json');
let results;
try {
  results = JSON.parse(await readFile(resultPath, 'utf8'));
} catch {
  results = null;
}
const valueAt = (value, path) =>
  path
    .split('.')
    .reduce(
      (current, segment) =>
        Array.isArray(current) ? current.find((item) => item.role === segment) : current?.[segment],
      value,
    );
let manifestSizes;
const readManifestSizes = async () => {
  if (manifestSizes) return manifestSizes;
  const manifest = JSON.parse(
    await readFile(resolve(packageRoot, 'out/renderer/.vite/manifest.json'), 'utf8'),
  );
  manifestSizes = await Promise.all(
    Object.values(manifest)
      .filter((entry) => typeof entry.file === 'string' && entry.file.endsWith('.js'))
      .map((entry) =>
        stat(resolve(packageRoot, 'out/renderer', entry.file)).then((item) => item.size),
      ),
  );
  return manifestSizes;
};
let compared = 0;
for (const [path, budget] of Object.entries(budgets)) {
  let value = valueAt(results, path);
  if (path === 'bundle.maxChunkBytes' || path === 'bundle.totalJsBytes') {
    try {
      const sizes = await readManifestSizes();
      value =
        path === 'bundle.maxChunkBytes'
          ? Math.max(0, ...sizes)
          : sizes.reduce((total, bytes) => total + bytes, 0);
    } catch {
      // Fall back to the most recent recorded measurement when no build is available.
    }
  }
  if (typeof value !== 'number') continue;
  compared += 1;
  if (value > budget.max)
    console.warn(
      `PERF BUDGET WARNING ${path}: ${value} ${budget.unit} > ${budget.max} ${budget.unit}`,
    );
}
console.log(
  compared
    ? `Perf budget warning check compared ${compared} measurement(s); this step never fails the build.`
    : 'Perf budget warning check found no measurements; run pnpm perf to populate docs/perf-results.json.',
);
