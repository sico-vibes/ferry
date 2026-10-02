import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(packageDirectory, '../../..');

function parseDesignTokens(design: string): ReadonlyMap<string, string> {
  const tokens = new Map<string, string>();
  const tokenSection = design.split('## 2. Tokens')[1]?.split('\n## ')[0] ?? '';
  for (const line of tokenSection.split('\n')) {
    const columns = line.split('|');
    const names = columns[1]?.match(/--[A-Za-z0-9-]+/g);
    const values = [...(columns[2] ?? '').matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? '');
    if (!names || !values.length) continue;
    names.forEach((name, index) => {
      const value = values[index];
      if (value !== undefined) tokens.set(name, value);
    });
  }
  return tokens;
}

function parseCssTokens(css: string): ReadonlyMap<string, string> {
  const tokens = new Map<string, string>();
  for (const match of css.matchAll(/(--[A-Za-z0-9-]+)\s*:\s*([^;]+);/g)) {
    const name = match[1];
    const value = match[2];
    if (name !== undefined && value !== undefined) tokens.set(name, value.trim());
  }
  return tokens;
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/\b0\.(\d)/g, '.$1')
    .replace(/px$/, '');
}

const designedTokens = parseDesignTokens(
  readFileSync(resolve(repositoryRoot, 'design/DESIGN-v2.md'), 'utf8'),
);
const darkThemeTokens =
  /\.ferry-ui\s*\{([^}]*)\}/.exec(
    readFileSync(resolve(packageDirectory, '../src/styles/tokens.css'), 'utf8'),
  )?.[1] ?? '';
const cssTokens = parseCssTokens(darkThemeTokens);
const lightCssTokens = parseCssTokens(
  readFileSync(resolve(packageDirectory, '../src/styles/light-tokens.css'), 'utf8'),
);
const v2TokenNames = new Set(designedTokens.keys());
const lightV2ThemeTokens = parseCssTokens(
  /\.ferry-ui\.light\s*,\s*\.light\s+\.ferry-ui:not\(\.dark\)\s*\{([^}]*)\}/.exec(
    readFileSync(resolve(packageDirectory, '../src/styles/tokens.css'), 'utf8'),
  )?.[1] ?? '',
);
const v2ThemeTokens = new Set([...cssTokens.keys()].filter((name) => lightV2ThemeTokens.has(name)));

describe('design tokens', () => {
  it('parses the v2 design spec tokens', () => {
    expect(designedTokens.size).toBeGreaterThan(0);
    expect(designedTokens.get('--background')).toBe('#0F0E14');
  });

  it('defines every v2 color token with its documented dark value', () => {
    for (const [name, value] of designedTokens) {
      expect(cssTokens.has(name), `missing token ${name}`).toBe(true);
      expect(normalize(cssTokens.get(name) ?? ''), name).toBe(normalize(value));
    }
  });

  it('mirrors legacy tokens from the dark sheets into the light sheet', () => {
    for (const sheet of ['tokens.css', 'effects.css', 'brand.css']) {
      const css = readFileSync(resolve(packageDirectory, `../src/styles/${sheet}`), 'utf8');
      for (const [name] of parseCssTokens(css)) {
        const isLegacyPaletteToken =
          /^(--(?:bg|border|text|blue|warn|legacy-success|danger|star|series|lang|brand|chip-text|tint|grad)-|--(?:overlay|spotlight|hero-mark|hero-tile|dot-color))/.test(
            name,
          );
        if (!isLegacyPaletteToken || v2TokenNames.has(name) || v2ThemeTokens.has(name)) continue;
        expect(lightCssTokens.has(name), `missing light token ${name}`).toBe(true);
      }
    }
  });
});
