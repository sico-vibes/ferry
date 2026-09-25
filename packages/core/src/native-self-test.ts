import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export function runNativeSelfTest() {
  const names = ['better-sqlite3', 'node-pty', '@napi-rs/keyring'];
  return {
    modules: names.map((name) => {
      try {
        const loaded: unknown = require(name);
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
