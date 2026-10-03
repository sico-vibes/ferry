import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function latestMigrationVersion(): Promise<number> {
  const directory = join(dirname(fileURLToPath(import.meta.url)), '../src/migrations');
  const versions = (await readdir(directory))
    .map((file) => /^(\d{4})_.+\.sql$/.exec(file)?.[1])
    .filter((version): version is string => version !== undefined)
    .map(Number);
  if (versions.length === 0) throw new Error('No storage migrations were found');
  return Math.max(...versions);
}
