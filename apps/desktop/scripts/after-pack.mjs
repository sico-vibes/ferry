import { cp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

export default async function copyCliRuntimeDependencies(context) {
  const source = resolve(import.meta.dirname, '..', 'out', 'cli', 'node_modules');
  const destination = resolve(context.appOutDir, 'resources', 'cli', 'node_modules');
  await mkdir(destination, { recursive: true });
  await cp(source, destination, { recursive: true, dereference: true });
}
