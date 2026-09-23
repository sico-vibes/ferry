import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { UI_PACKAGE } from '../src/index.js';

const packageDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(packageDirectory, '../../..');

describe('UI package scaffold', () => {
  it('exports its package marker', () => {
    expect(UI_PACKAGE).toBe('@ferry/ui');
  });

  it('defines the required design tokens', async () => {
    const css = await readFile(resolve(packageDirectory, '../src/styles/tokens.css'), 'utf8');
    expect(css).toMatch(/--bg-app\s*:/);
    expect(css).toMatch(/--grad-signature\s*:/);
    expect(css).toMatch(/--r-panel\s*:/);
  });

  it('reports raw colors in UI source through ESLint', async () => {
    const eslint = new ESLint({ cwd: repositoryRoot, ignore: false });
    const [result] = await eslint.lintFiles([
      resolve(packageDirectory, '../src/__lint_fixture__/raw-color.fixture.tsx'),
    ]);
    expect(result?.messages.some((message) =>
      message.message.includes('Use design tokens (packages/ui/src/styles/tokens.css)'),
    )).toBe(true);
  });
});
