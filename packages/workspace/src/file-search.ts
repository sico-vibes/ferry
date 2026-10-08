import { execFile } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { basename } from 'node:path';
import { promisify } from 'node:util';
import { rgPath } from '@vscode/ripgrep';

const execute = promisify(execFile);
export interface FileSearchEntry {
  path: string;
  name: string;
}

/** Lower is better: exact, prefix, substring, then ordered fuzzy characters. */
export function fileNameScore(name: string, query: string): number | null {
  if (!query) return 0;
  if (name === query) return 0;
  if (name.startsWith(query)) return 1 + (name.length - query.length) / 1000;
  const start = name.indexOf(query);
  if (start >= 0) return 2 + start / 1000;
  let cursor = 0;
  let gaps = 0;
  for (const char of query) {
    const next = name.indexOf(char, cursor);
    if (next < 0) return null;
    gaps += next - cursor;
    cursor = next + 1;
  }
  return 3 + gaps / 1000 + name.length / 100000;
}

/** One rg inventory per root per 30 seconds; concurrent first calls share the subprocess. */
export class WorkspaceFileSearch {
  private readonly cache = new Map<
    string,
    { expires: number; entries: Promise<(FileSearchEntry & { lower: string })[]> }
  >();
  invalidate(root: string): void {
    this.cache.delete(root);
  }
  async search(root: string, query: string, limit = 50): Promise<FileSearchEntry[]> {
    let cached = this.cache.get(root);
    if (!cached || cached.expires <= performance.now()) {
      const entries = execute(
        rgPath,
        ['--files', '--hidden', '--no-require-git', '-g', '!.git/**', '-0'],
        {
          cwd: root,
          windowsHide: true,
          maxBuffer: 32 * 1024 * 1024,
          timeout: 10000,
        },
      )
        .then(({ stdout }) =>
          stdout
            .split('\0')
            .filter(Boolean)
            .map((path) => {
              const name = basename(path);
              return { path, name, lower: name.toLocaleLowerCase() };
            }),
        )
        .catch((error: unknown) => {
          this.cache.delete(root);
          if (typeof error === 'object' && error !== null && 'code' in error && error.code === 1)
            return [];
          throw error;
        });
      cached = { expires: performance.now() + 30000, entries };
      this.cache.set(root, cached);
    }
    const needle = query.trim().toLocaleLowerCase();
    return (await cached.entries)
      .flatMap((entry) => {
        const score = fileNameScore(entry.lower, needle);
        return score === null ? [] : [{ entry, score }];
      })
      .sort((a, b) => a.score - b.score || a.entry.path.localeCompare(b.entry.path))
      .slice(0, limit)
      .map(({ entry: { path, name } }) => ({ path, name }));
  }
}
