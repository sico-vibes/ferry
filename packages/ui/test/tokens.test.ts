import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(packageDirectory, '../../..');

function parseDesignTokens(design: string): ReadonlyMap<string, string> {
  const start = design.indexOf('### 2.1');
  const end = design.indexOf('### 2.7');
  const section = start >= 0 && end > start ? design.slice(start, end) : '';
  const spans = [...section.matchAll(/`([^`]*)`/g)].map((match) => match[1] ?? '');
  const tokens = new Map<string, string>();

  spans.forEach((span, index) => {
    const inline = /^(--[A-Za-z0-9-]+):\s*(.+)$/.exec(span);
    const inlineName = inline?.[1];
    const inlineValue = inline?.[2];
    if (inlineName !== undefined && inlineValue !== undefined) {
      tokens.set(inlineName, inlineValue);
      return;
    }

    const spaced = /^(--[A-Za-z0-9-]+)\s+(\d[0-9]*)$/.exec(span);
    const spacedName = spaced?.[1];
    const spacedValue = spaced?.[2];
    if (spacedName !== undefined && spacedValue !== undefined) {
      tokens.set(spacedName, spacedValue);
      return;
    }

    if (/^--[A-Za-z0-9-]+$/.test(span)) {
      const next = spans[index + 1];
      if (next !== undefined && next !== '' && !next.startsWith('--')) {
        tokens.set(span, next);
      }
    }
  });

  return tokens;
}

function parseCssTokens(css: string): ReadonlyMap<string, string> {
  const tokens = new Map<string, string>();
  for (const match of css.matchAll(/(--[A-Za-z0-9-]+)\s*:\s*([^;]+);/g)) {
    const name = match[1];
    const value = match[2];
    if (name !== undefined && value !== undefined) {
      tokens.set(name, value.trim());
    }
  }
  return tokens;
}

function normalize(value: string): string {
  return value.endsWith('px') ? value.slice(0, -2) : value;
}

const designedTokens = parseDesignTokens(
  readFileSync(resolve(repositoryRoot, 'design/DESIGN.md'), 'utf8'),
);
const cssTokens = parseCssTokens(
  readFileSync(resolve(packageDirectory, '../src/styles/tokens.css'), 'utf8'),
);
const lightCssTokens = parseCssTokens(
  readFileSync(resolve(packageDirectory, '../src/styles/light-tokens.css'), 'utf8'),
);

describe('design tokens', () => {
  it('parses the design spec tokens (sanity check on the parser)', () => {
    expect(designedTokens.size).toBeGreaterThan(0);
    expect(designedTokens.get('--bg-app')).toBe('#1C1D20');
    expect(designedTokens.get('--r-window')).toBe('12');
  });

  it('defines every DESIGN.md section 2.1-2.6 token with its exact value', () => {
    for (const [name, value] of designedTokens) {
      expect(cssTokens.has(name), `missing token ${name}`).toBe(true);
      expect(normalize(cssTokens.get(name) ?? ''), name).toBe(normalize(value));
    }
  });

  it('introduces no tokens beyond DESIGN.md section 2.1-2.6', () => {
    const extras = [...cssTokens.keys()].filter((name) => !designedTokens.has(name));
    expect(extras, `unexpected tokens: ${extras.join(', ')}`).toEqual([]);
  });
  it('mirrors every token from all dark token sheets in the light sheet', () => {
    for (const sheet of ['tokens.css', 'effects.css', 'brand.css']) {
      const css = readFileSync(resolve(packageDirectory, `../src/styles/${sheet}`), 'utf8');
      for (const [name] of parseCssTokens(css)) {
        expect(lightCssTokens.has(name), `missing light token ${name}`).toBe(true);
      }
    }
  });

  it('mirrors every dark token into the light theme', () => {
    for (const sheet of ['tokens.css', 'effects.css', 'brand.css']) {
      const css = readFileSync(resolve(packageDirectory, `../src/styles/${sheet}`), 'utf8');
      for (const [name] of parseCssTokens(css)) {
        expect(lightCssTokens.has(name), `missing light token ${name}`).toBe(true);
      }
    }
  });
});
