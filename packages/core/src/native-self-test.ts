import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveFerryRuntimePaths } from '@ferry/shared/electron-paths';

export function runNativeSelfTest() {
  const runtimePaths = resolveFerryRuntimePaths({
    entryFilePath: fileURLToPath(import.meta.url),
    execPath: process.execPath,
    env: process.env,
    resourcesPath: (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath,
    exists: existsSync,
  });
  const nativeRequire = createRequire(runtimePaths.nativeModuleAnchor);
  const names = ['better-sqlite3', 'node-pty', '@napi-rs/keyring'];
  return {
    modules: names.map((name) => {
      try {
        const loaded: unknown = nativeRequire(name);
        const version =
          typeof loaded === 'object' &&
          loaded !== null &&
          'version' in loaded &&
          typeof loaded.version === 'string'
            ? loaded.version
            : 'loaded';
        return { name, ok: true, version, error: null };
      } catch (error) {
        return {
          name,
          ok: false,
          version: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  };
}
