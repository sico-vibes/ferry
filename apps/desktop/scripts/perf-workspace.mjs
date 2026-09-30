import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { rgPath } from '@vscode/ripgrep';
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
const measureRgAlone = (args, cwd) =>
  new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const child = spawn(rgPath, args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('error', reject);
    child.once('close', (code) => {
      const result = {
        benchmark: 'large-workspace-rg-alone',
        binary: rgPath,
        args,
        elapsedMs: Number((performance.now() - startedAt).toFixed(1)),
        exitCode: code,
        stderr: stderr.slice(0, 500),
      };
      if (code !== 0 && code !== 1) reject(new Error(JSON.stringify(result)));
      else resolve(result);
    });
    child.stdout.resume();
  });
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
  const record = async (name, operation) => {
    const result = await elapsed(name, operation);
    operations.push(result);
    console.log(JSON.stringify({ benchmark: 'large-workspace-operation', ...result }));
  };
  await record('repoMap', async () => (await buildRepoMap(tools.jail)).files);
  await record('glob', () => tools.glob({ pattern: '**/*' }));
  await record('grep', () => tools.grep({ pattern: 'needle 49999', glob: '**/*.txt' }));
  const rgArgs = [
    '--no-config',
    '--json',
    '--line-number',
    '--color',
    'never',
    '--context',
    '0',
    '--max-count',
    '1',
    '--max-depth',
    '12',
    '--max-columns',
    '500',
    '--max-columns-preview',
    '--max-filesize',
    '2097152',
    '--glob',
    '**/*.txt',
    '--glob',
    '!.git/**',
    '--glob',
    '!node_modules/**',
    '--',
    'needle 49999',
    root,
  ];
  await measureRgAlone(rgArgs, root).then((result) => console.log(JSON.stringify(result)));
  await record('listDir', () => tools.listDir({ path: '.', depth: 2 }));
  const checkpoints = new ShadowCheckpoints(tools.jail, dataDir);
  await record('checkpointSnapshot', async () => {
    await checkpoints.snapshot('50k fixture');
    return ['snapshot'];
  });
  const result = {
    benchmark: 'large-workspace',
    fixtureLocation: 'os-temp',
    fixtureFiles: fileCount,
    fixtureGenerationMs: Number((fixtureReady - fixtureStart).toFixed(1)),
    targetGrepMs: 5_000,
    operations,
    memoryBytes: process.memoryUsage(),
  };
  console.log(JSON.stringify(result));
  if ((operations.find((operation) => operation.name === 'grep')?.elapsedMs ?? 0) >= 5_000)
    process.exitCode = 1;
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  await rm(dataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}
