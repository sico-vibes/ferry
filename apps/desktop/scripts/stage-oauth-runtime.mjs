import { cp, mkdir, readFile, realpath, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Variable provider imports and import.meta.resolve need the real pi-ai package tree.
// Copy the installed production closure, including dependencies with conflicting versions.
export async function stageOAuthRuntime(targetDirectory) {
  const sourceAnchor = fileURLToPath(
    new URL('../../../packages/oauth/package.json', import.meta.url),
  );
  const copied = new Map();
  const rootModules = resolve(targetDirectory);
  async function stage(name, anchor, parentModules = rootModules) {
    const require = createRequire(anchor);
    let search = dirname(anchor);
    let source;
    while (true) {
      const candidate = join(search, 'node_modules', ...name.split('/'));
      if (
        await access(join(candidate, 'package.json')).then(
          () => true,
          () => false,
        )
      ) {
        source = await realpath(candidate);
        break;
      }
      const parent = dirname(search);
      if (parent === search) throw new Error(`Installed OAuth dependency is missing: ${name}`);
      search = parent;
    }
    const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
    let destination = join(rootModules, ...name.split('/'));
    if (copied.has(destination) && copied.get(destination) !== source)
      destination = join(parentModules, ...name.split('/'));
    if (copied.get(destination) === source) return;
    if (copied.has(destination)) throw new Error(`Conflicting OAuth runtime dependency: ${name}`);
    copied.set(destination, source);
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination, {
      recursive: true,
      dereference: true,
      filter: (path) => path !== join(source, 'node_modules'),
    });
    for (const dependency of Object.keys(manifest.dependencies ?? {}))
      await stage(dependency, join(source, 'package.json'), join(destination, 'node_modules'));
    for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) {
      try {
        require.resolve(dependency);
      } catch {
        continue;
      }
      await stage(dependency, join(source, 'package.json'), join(destination, 'node_modules'));
    }
  }
  await stage('@earendil-works/pi-ai', sourceAnchor);
}
