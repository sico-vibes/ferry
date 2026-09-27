import { rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { describe, it } from 'vitest';
import { WorkspaceJail } from '../src/fs.js';
import { gitBranch } from '../src/git.js';
import { buildRepoMap } from '../src/repo-map.js';
import { WorkspaceTools } from '../src/tools.js';

const enabled = process.env.FERRY_RUN_LARGE_REPO_PERF === '1';

describe.skipIf(!enabled)('large repository performance fixture', () => {
  it('measures open, file search, glob, and cold/warm repo map at 50k files', async () => {
    const root = await fsTempDirectory();
    try {
      const batchSize = 500;
      for (let start = 0; start < 50_000; start += batchSize) {
        const end = Math.min(start + batchSize, 50_000);
        await Promise.all(
          Array.from({ length: end - start }, (_, offset) => {
            const index = start + offset;
            const extension = index < 100 ? 'ts' : 'md';
            const filename = `fixture-${String(index).padStart(5, '0')}.${extension}`;
            const content =
              extension === 'ts'
                ? `export function fixture${String(index)}() { return 'needle'; }\n`
                : `Large repository fixture ${String(index)} includes needle.\n`;
            return writeFile(path.join(root, filename), content, 'utf8');
          }),
        );
      }

      const openStarted = performance.now();
      const jail = new WorkspaceJail(root);
      await jail.initialize();
      const entries = await fsReaddir(root);
      const branch = await gitBranch(jail).catch(() => ({ current: null }));
      const openMs = performance.now() - openStarted;

      const tools = new WorkspaceTools(root);
      const globStarted = performance.now();
      const globbed = await tools.glob({ pattern: '**/*.md' });
      const globMs = performance.now() - globStarted;

      const mapStarted = performance.now();
      const coldMap = buildRepoMap(jail);
      const searchStarted = performance.now();
      const concurrentMatches = await tools.grep({ pattern: 'needle' });
      const searchDuringMapMs = performance.now() - searchStarted;
      await coldMap;
      const coldMapMs = performance.now() - mapStarted;

      const warmMapStarted = performance.now();
      await buildRepoMap(jail);
      const warmMapMs = performance.now() - warmMapStarted;
      process.stderr.write(
        `LARGE_REPO_PERF ${JSON.stringify({
          files: entries.length,
          language: branch.current,
          openMs: Number(openMs.toFixed(1)),
          globMs: Number(globMs.toFixed(1)),
          globResults: globbed.length,
          concurrentSearchMs: Number(searchDuringMapMs.toFixed(1)),
          concurrentSearchResults: concurrentMatches.length,
          coldRepoMapMs: Number(coldMapMs.toFixed(1)),
          warmRepoMapMs: Number(warmMapMs.toFixed(1)),
        })}\n`,
      );
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  }, 180_000);
});

async function fsTempDirectory(): Promise<string> {
  const parent = os.tmpdir();
  const { mkdtemp } = await import('node:fs/promises');
  return mkdtemp(path.join(parent, 'ferry-large-repo-perf-'));
}

async function fsReaddir(directory: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  return readdir(directory);
}
