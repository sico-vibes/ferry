import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { UI_PACKAGE } from '../src/index.js';

describe('UI package scaffold', () => {
  it('exports its package marker', () => {
    expect(UI_PACKAGE).toBe('@ferry/ui');
  });

  it('defines the required design tokens', async () => {
    const css = await readFile(new URL('../src/styles/tokens.css', import.meta.url), 'utf8');
    expect(css).toMatch(/--bg-app\s*:/);
    expect(css).toMatch(/--grad-signature\s*:/);
    expect(css).toMatch(/--r-panel\s*:/);
  });
});
