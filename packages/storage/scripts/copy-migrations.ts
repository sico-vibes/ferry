import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export async function copyStorageMigrations(
  sourceDirectory: string,
  outputDirectory: string,
): Promise<string[]> {
  const files = (await readdir(sourceDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort();
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all(
    files.map((file) => copyFile(join(sourceDirectory, file), join(outputDirectory, file))),
  );
  return files;
}
