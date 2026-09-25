import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceJail } from '../src/fs.js';
import { buildRepoMap, clearRepoMapCache } from '../src/repo-map.js';

const roots: string[] = [];
async function fixtureRepo(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ferry-repo-map-'));
  roots.push(root);
  return root;
}
afterEach(async () => {
  clearRepoMapCache();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('repo map', () => {
  it('extracts symbols from TypeScript, Python, Go, and Rust fixtures', async () => {
    const root = await fixtureRepo();
    await writeFile(
      path.join(root, 'entry.ts'),
      "import { helper } from './helper';\nexport function run() { return helper(); }\n",
    );
    await writeFile(
      path.join(root, 'helper.ts'),
      'export function helper(): string { return "ok"; }\n',
    );
    await writeFile(
      path.join(root, 'worker.py'),
      'class Worker:\n    def start(self):\n        return True\n',
    );
    await writeFile(
      path.join(root, 'worker.go'),
      'package worker\nfunc Start() bool { return true }\n',
    );
    await writeFile(path.join(root, 'worker.rs'), 'pub fn start() -> bool { true }\n');

    const result = await buildRepoMap(new WorkspaceJail(root));
    const paths = result.files.map((file) => file.path);
    const names = result.files.flatMap((file) => file.symbols.map((symbol) => symbol.name));
    expect(paths).toEqual(
      expect.arrayContaining(['entry.ts', 'helper.ts', 'worker.py', 'worker.go', 'worker.rs']),
    );
    expect(names).toEqual(expect.arrayContaining(['run', 'helper', 'Worker', 'Start', 'start']));
    expect(result.files.find((file) => file.path === 'helper.ts')?.score).toBeGreaterThan(
      result.files.find((file) => file.path === 'entry.ts')?.score ?? 0,
    );
  });

  it('respects the token budget and caches parse results by content hash', async () => {
    const root = await fixtureRepo();
    await writeFile(
      path.join(root, 'many.ts'),
      Array.from(
        { length: 40 },
        (_, index) => `export function function${String(index)}() { return ${String(index)}; }`,
      ).join('\n'),
    );
    const jail = new WorkspaceJail(root);
    const first = await buildRepoMap(jail, { tokenBudget: 220 });
    const second = await buildRepoMap(jail, { tokenBudget: 220 });
    expect(first.tokenCount).toBeLessThanOrEqual(220);
    expect(first.text).toBe(second.text);
  }, 15_000);
});
