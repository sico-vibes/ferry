import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { WorkspaceTools, buildRepoMap, ShadowCheckpoints } from '@ferry/workspace';

const fileCount = Number(process.env.FERRY_PERF_FILE_COUNT ?? 50_000);
const root = await mkdtemp(join(tmpdir(), 'ferry-perf-large-repo-'));
const dataDir = await mkdtemp(join(tmpdir(), 'ferry-perf-checkpoints-'));
const tools = new WorkspaceTools(root);
const elapsed = async (name, operation) => {
  const before = performance.now();
  const value = await operation();
  return { name, elapsedMs: Number((performance.now() - before).toFixed(1)), count: value.length };
};
try {
  const fixtureStart = performance.now();
  const groupCount = Math.ceil(fileCount / 500);
  await Promise.all(
    Array.from({ length: groupCount }, (_, groupIndex) =>
      mkdir(join(root, `group-${String(groupIndex).padStart(3, '0')}`), { recursive: true }),
    ),
  );
  const batchSize = 250;
  for (let start = 0; start < fileCount; start += batchSize) {
    const end = Math.min(fileCount, start + batchSize);
    await Promise.all(
      Array.from({ length: end - start }, async (_, offset) => {
        const index = start + offset;
        const directory = join(root, `group-${String(Math.floor(index / 500)).padStart(3, '0')}`);
        const extension = index % 100 === 0 ? 'ts' : 'txt';
        await writeFile(
          join(directory, `module-${String(index).padStart(5, '0')}.${extension}`),
          `export const fixture${index} = ${index};\nneedle ${index}\n`,
        );
      }),
    );
  }
  await tools.jail.initialize();
  const fixtureReady = performance.now();
  const operations = [];
  operations.push(
    await elapsed('repoMap', async () => (await buildRepoMap(tools.jail)).files),
    await elapsed('glob', () => tools.glob({ pattern: '**/*' })),
    await elapsed('grep', () => tools.grep({ pattern: 'needle 49999', glob: '**/*.txt' })),
    await elapsed('listDir', () => tools.listDir({ path: '.', depth: 2 })),
  );
  const checkpoints = new ShadowCheckpoints(tools.jail, dataDir);
  operations.push(
    await elapsed('checkpointSnapshot', async () => {
      await checkpoints.snapshot('50k fixture');
      return ['snapshot'];
    }),
  );
  console.log(
    JSON.stringify({
      benchmark: 'large-workspace',
      root,
      fixtureFiles: fileCount,
      fixtureGenerationMs: Number((fixtureReady - fixtureStart).toFixed(1)),
      operations,
      memoryBytes: process.memoryUsage(),
    }),
  );
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  await rm(dataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}
