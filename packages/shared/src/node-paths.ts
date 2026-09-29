import { realpathSync } from 'node:fs';
import path from 'node:path';

/** Resolve through the nearest accessible ancestor, preserving missing suffixes. */
export function canonicalizePath(value: string): string {
  const target = path.resolve(value);
  let cursor = target;
  const missing: string[] = [];

  for (;;) {
    try {
      const existing = realpathSync.native(cursor);
      return path.resolve(existing, ...missing.reverse());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') return target;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      const parent = path.dirname(cursor);
      // A syntactically valid path can target an unavailable volume (for example
      // a simulated drive in a platform-specific configuration test).
      if (parent === cursor) return target;
      missing.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

/** Return a stable key for filesystem identities, folding Windows path case. */
export function canonicalPathKey(value: string): string {
  const canonical = canonicalizePath(value);
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

/** Normalize an already-resolved path for comparisons without filesystem access. */
export function normalizedPathKey(value: string): string {
  const normalized = path.resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
