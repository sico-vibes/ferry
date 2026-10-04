import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

const runtimeModuleWrappers = new Map([
  [
    'better-sqlite3',
    [
      'const load = () => __ferryLoadNativeModule("better-sqlite3");',
      'const Database = new Proxy(function FerryDatabase() {}, {',
      '  get(_target, property) { return Reflect.get(load(), property); },',
      '  apply(_target, thisArgument, argumentsList) { return Reflect.apply(load(), thisArgument, argumentsList); },',
      '  construct(_target, argumentsList) { return Reflect.construct(load(), argumentsList); },',
      '});',
      'export default Database;',
    ].join('\n'),
  ],
  [
    'node-pty',
    [
      'const load = () => __ferryLoadNativeModule("node-pty");',
      'export const spawn = (...argumentsList) => load().spawn(...argumentsList);',
      'export default new Proxy({}, { get(_target, property) { return Reflect.get(load(), property); } });',
    ].join('\n'),
  ],
  [
    'pino',
    [
      'const load = () => __ferryLoadNativeModule("pino");',
      'const pino = new Proxy(function FerryPino(...argumentsList) { return Reflect.apply(load(), this, argumentsList); }, {',
      '  apply(_target, thisArgument, argumentsList) { return Reflect.apply(load(), thisArgument, argumentsList); },',
      '  get(_target, property) { return Reflect.get(load(), property); },',
      '});',
      'export default pino;',
    ].join('\n'),
  ],
  [
    '@napi-rs/keyring',
    [
      'const load = () => __ferryLoadNativeModule("@napi-rs/keyring");',
      'export const Entry = new Proxy(function FerryKeyringEntry() {}, {',
      '  construct(_target, argumentsList) { return Reflect.construct(load().Entry, argumentsList); },',
      '});',
      'export default new Proxy({}, { get(_target, property) { return Reflect.get(load(), property); } });',
    ].join('\n'),
  ],
  [
    '@vscode/ripgrep',
    [
      'let rgPath = "";',
      'try {',
      '  const runtimePaths = resolveFerryRuntimePaths({ entryFilePath: fileURLToPath(import.meta.url), execPath: process.execPath, env: process.env, resourcesPath: process.resourcesPath, exists: existsSync });',
      '  const nativeRequire = __ferryCreateRequire(runtimePaths.nativeModuleAnchor);',
      '  const modulePath = nativeRequire.resolve("@vscode/ripgrep");',
      '  const loaded = await import(pathToFileURL(modulePath).href);',
      '  rgPath = loaded.rgPath ?? "";',
      '} catch {',
      '  // Plain-Node CLI smoke copies do not include the desktop app archive.',
      '}',
      'export { rgPath };',
      'export default { get rgPath() { return rgPath; } };',
    ].join('\n'),
  ],
]);

export async function stageCliRuntime({ sourceDirectory, targetDirectory }) {
  sourceDirectory = resolve(sourceDirectory);
  targetDirectory = resolve(targetDirectory);
  await rm(targetDirectory, { recursive: true, force: true });
  await mkdir(targetDirectory, { recursive: true });
  await cp(resolve(sourceDirectory, 'ferry.js'), resolve(targetDirectory, 'ferry.js'));
  await cp(
    resolve(sourceDirectory, 'runtime-paths.js'),
    resolve(targetDirectory, 'runtime-paths.js'),
  );
  await cp(resolve(sourceDirectory, 'migrations'), resolve(targetDirectory, 'migrations'), {
    recursive: true,
  });

  for (const [name, entryPoint] of runtimeModuleWrappers) {
    const moduleDirectory = resolve(targetDirectory, 'node_modules', ...name.split('/'));
    const runtimePathsSpecifier = `${relative(moduleDirectory, targetDirectory).replaceAll('\\', '/')}/runtime-paths.js`;
    await mkdir(moduleDirectory, { recursive: true });
    await writeFile(
      resolve(moduleDirectory, 'package.json'),
      '{"type":"module","exports":"./index.js"}\n',
      'utf8',
    );
    await writeFile(
      resolve(moduleDirectory, 'index.js'),
      [
        'import { createRequire as __ferryCreateRequire } from "node:module";',
        'import { existsSync } from "node:fs";',
        'import { fileURLToPath } from "node:url";',
        `import { resolveFerryRuntimePaths } from "${runtimePathsSpecifier}";`,
        ...(name === '@vscode/ripgrep' ? ['import { pathToFileURL } from "node:url";'] : []),
        'let __ferryNativeRequire;',
        'function __ferryLoadNativeModule(name) {',
        '  __ferryNativeRequire ??= __ferryCreateRequire(resolveFerryRuntimePaths({ entryFilePath: fileURLToPath(import.meta.url), execPath: process.execPath, env: process.env, resourcesPath: process.resourcesPath, exists: existsSync }).nativeModuleAnchor);',
        '  return __ferryNativeRequire(name);',
        '}',
        entryPoint,
      ].join('\n'),
      'utf8',
    );
  }
  await writeFile(
    resolve(targetDirectory, 'ferry.cmd'),
    '@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"%~dp0..\\..\\Ferry.exe" "%~dp0ferry.js" %*\r\n',
    'utf8',
  );
}
