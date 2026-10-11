import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

/** Prune rotated logs only, retaining the most recently written file for active logging. */
export async function pruneLogFiles(directory: string, before: Date): Promise<number> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && /\.log(?:\.\d+)?$/.test(entry.name))
      .map(async (entry) => {
        const path = join(directory, entry.name);
        return { path, modified: (await stat(path)).mtimeMs };
      }),
  );
  files.sort((a, b) => b.modified - a.modified);
  let deleted = 0;
  for (const file of files.slice(1)) {
    if (file.modified >= before.getTime()) continue;
    await unlink(file.path);
    deleted++;
  }
  return deleted;
}
