import { canonicalizePath } from '@ferry/shared/node-paths';
import { fileURLToPath, pathToFileURL } from 'node:url';

interface FileUrlComparisonOptions {
  platform?: NodeJS.Platform;
  canonicalize?: (path: string) => string;
}

export function isTrustedRendererOrigin(
  url: string,
  devUrl?: string,
  rendererFileUrl?: string,
  options: FileUrlComparisonOptions = {},
): boolean {
  try {
    const actual = new URL(url);
    if (devUrl) {
      const expected = new URL(devUrl);
      return actual.origin === expected.origin && actual.pathname === expected.pathname;
    }
    if (!rendererFileUrl) return false;
    const expected = new URL(rendererFileUrl);
    if (
      actual.protocol !== 'file:' ||
      actual.host !== '' ||
      expected.protocol !== 'file:' ||
      expected.host !== ''
    )
      return false;

    const canonicalize = options.canonicalize ?? canonicalizePath;
    const actualPath = pathToFileURL(canonicalize(fileURLToPath(actual))).href;
    const expectedPath = pathToFileURL(canonicalize(fileURLToPath(expected))).href;
    return options.platform === 'win32' || (!options.platform && process.platform === 'win32')
      ? actualPath.toLowerCase() === expectedPath.toLowerCase()
      : actualPath === expectedPath;
  } catch {
    return false;
  }
}
