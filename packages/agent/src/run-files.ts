import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import type { RunReport } from '@ferry/shared';

interface Fingerprint {
  hash: string;
  sizeBytes: number;
}
/** Observe command mutations without assuming a shell command's name means it wrote files. */
export async function snapshotRunFiles(
  root: string,
  dataDir: string,
): Promise<Map<string, Fingerprint>> {
  const files = new Map<string, Fingerprint>();
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (
        resolve(file) === resolve(dataDir) ||
        ['.git', 'node_modules', '.ferry'].includes(entry.name)
      )
        continue;
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) {
        try {
          const content = await readFile(file);
          files.set(relative(root, file), {
            hash: createHash('sha256').update(content).digest('hex'),
            sizeBytes: content.length,
          });
        } catch {
          /* Files may disappear while the command's workspace is being observed. */
        }
      }
    }
  };
  await visit(root);
  return files;
}

export function changedRunFiles(
  before: ReadonlyMap<string, Fingerprint>,
  after: ReadonlyMap<string, Fingerprint>,
): RunReport['filesChanged'] {
  return [...new Set([...before.keys(), ...after.keys()])].sort().flatMap((path) => {
    const old = before.get(path);
    const next = after.get(path);
    return old?.hash === next?.hash
      ? []
      : [
          {
            path,
            sizeBytes: next?.sizeBytes ?? 0,
            status: !old
              ? ('added' as const)
              : !next
                ? ('deleted' as const)
                : ('modified' as const),
          },
        ];
  });
}
