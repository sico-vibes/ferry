import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalPathKey, canonicalizePath } from '../src/node-paths.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })),
  );
});

describe('canonical path identities', () => {
  it('resolves junction or symlink aliases and preserves missing suffixes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ferry-path-alias-'));
    roots.push(root);
    const target = join(root, 'long-directory-name');
    const alias = join(root, 'short-alias');
    await mkdir(target);
    await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');

    expect(canonicalizePath(alias)).toBe(canonicalizePath(target));
    expect(canonicalizePath(join(alias, 'new', 'file.txt'))).toBe(
      canonicalizePath(join(target, 'new', 'file.txt')),
    );
    expect(canonicalPathKey(alias)).toBe(canonicalPathKey(target));
  }, 30_000);
});
