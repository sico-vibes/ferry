import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');
const indexCss = readFileSync(new URL('./index.css', import.meta.url), 'utf8');
const required = [
  'background',
  'foreground',
  'card',
  'card-foreground',
  'popover',
  'popover-foreground',
  'primary',
  'primary-foreground',
  'secondary',
  'secondary-foreground',
  'muted',
  'muted-foreground',
  'accent',
  'accent-foreground',
  'destructive',
  'destructive-foreground',
  'border',
  'input',
  'ring',
  'success',
  'warning',
  'sidebar',
  'sidebar-foreground',
  'sidebar-primary',
  'sidebar-primary-foreground',
  'sidebar-accent',
  'sidebar-accent-foreground',
  'sidebar-border',
  'sidebar-ring',
];
const tokensFor = (selector: string) => {
  const start = css.indexOf(selector);
  const blockStart = css.indexOf('{', start);
  const blockEnd = css.indexOf('}', blockStart);
  return css.slice(blockStart + 1, blockEnd);
};
const token = (block: string, name: string) =>
  new RegExp('--' + name + ':\\s*([^;]+);').exec(block)?.[1]?.trim();
const requiredToken = (block: string, name: string) => {
  const value = token(block, name);
  if (!value) throw new Error('Missing token --' + name);
  return value;
};
const rgb = (value: string) => {
  const hex = /^#([\da-f]{6})$/i.exec(value)?.[1];
  if (hex) {
    const channels = hex.match(/../g);
    if (!channels) throw new Error('Invalid hex color: ' + value);
    return channels.map((part) => parseInt(part, 16));
  }
  const rgba = /^rgba?\(([^)]+)\)$/.exec(value);
  if (!rgba?.[1]) throw new Error('Unsupported color token: ' + value);
  return rgba[1]
    .split(',')
    .slice(0, 3)
    .map((part) => Number(part.trim()));
};
const alpha = (value: string) =>
  Number(/^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)$/.exec(value)?.[1] ?? 1);
const composite = (top: string, bottom: string) => {
  const a = alpha(top);
  const fg = rgb(top);
  const bg = rgb(bottom);
  return (
    '#' +
    fg
      .map((channel, index) =>
        Math.round(channel * a + (bg[index] ?? 0) * (1 - a))
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
};
const luminance = (value: string) => {
  const [red = 0, green = 0, blue = 0] = rgb(value).map((channel) => channel / 255);
  const linear = (channel: number) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
};
const contrast = (foreground: string, background: string) => {
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return ((values[0] ?? 0) + 0.05) / ((values[1] ?? 0) + 0.05);
};

describe('UI v2 semantic tokens', () => {
  for (const theme of ['.ferry-ui', '.ferry-ui.light']) {
    const block = tokensFor(theme);
    it(theme + ' defines every shadcn semantic token', () => {
      for (const name of required) expect(token(block, name), name).toBeTruthy();
    });
    it(theme + ' passes AA text contrast on semantic surfaces', () => {
      const backgrounds = ['background', 'sidebar', 'card', 'muted', 'popover', 'secondary'];
      for (const surface of backgrounds) {
        expect(
          contrast(requiredToken(block, 'foreground'), requiredToken(block, surface)),
          'foreground on ' + surface,
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          contrast(requiredToken(block, 'muted-foreground'), requiredToken(block, surface)),
          'muted text on ' + surface,
        ).toBeGreaterThanOrEqual(4.5);
      }
      for (const [foreground, surface] of [
        ['card-foreground', 'card'],
        ['popover-foreground', 'popover'],
        ['sidebar-foreground', 'sidebar'],
      ] as const satisfies readonly (readonly [string, string])[]) {
        expect(
          contrast(requiredToken(block, foreground), requiredToken(block, surface)),
        ).toBeGreaterThanOrEqual(4.5);
      }
      expect(
        contrast(requiredToken(block, 'secondary-foreground'), requiredToken(block, 'secondary')),
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrast(requiredToken(block, 'primary-foreground'), requiredToken(block, 'primary')),
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrast(
          requiredToken(block, 'sidebar-primary-foreground'),
          requiredToken(block, 'sidebar-primary'),
        ),
      ).toBeGreaterThanOrEqual(4.5);
      const sidebarAccent = composite(
        requiredToken(block, 'sidebar-accent'),
        requiredToken(block, 'sidebar'),
      );
      expect(
        contrast(requiredToken(block, 'sidebar-accent-foreground'), sidebarAccent),
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrast(
          requiredToken(block, 'destructive-foreground'),
          requiredToken(block, 'destructive'),
        ),
      ).toBeGreaterThanOrEqual(4.5);
      for (const surface of ['background', 'sidebar', 'card', 'muted', 'popover', 'secondary']) {
        const tinted = composite(requiredToken(block, 'accent'), requiredToken(block, surface));
        expect(
          contrast(requiredToken(block, 'accent-foreground'), tinted),
          'accent text on ' + surface,
        ).toBeGreaterThanOrEqual(4.5);
        for (const status of ['success', 'warning']) {
          expect(
            contrast(requiredToken(block, status), requiredToken(block, surface)),
            status + ' on ' + surface,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    });
    it(theme + ' uses hairline surfaces and keeps focus rings at 3:1', () => {
      expect(requiredToken(block, 'border')).toBe(
        theme === '.ferry-ui' ? 'rgba(255, 255, 255, 0.06)' : 'rgba(23, 21, 30, 0.07)',
      );
      expect(requiredToken(block, 'input')).toBe(
        theme === '.ferry-ui' ? 'rgba(255, 255, 255, 0.12)' : 'rgba(23, 21, 30, 0.14)',
      );
      for (const surface of ['background', 'sidebar', 'card', 'muted', 'popover', 'secondary']) {
        expect(
          contrast(requiredToken(block, 'ring'), requiredToken(block, surface)),
          'ring on ' + surface,
        ).toBeGreaterThanOrEqual(3);
        if (surface === 'sidebar') {
          expect(
            contrast(requiredToken(block, 'sidebar-ring'), requiredToken(block, surface)),
          ).toBeGreaterThanOrEqual(3);
        }
      }
    });
  }

  it('keeps the computed legacy utility palette unchanged', () => {
    const root = tokensFor(':root');
    const legacyPalette = {
      'bg-app': '#1c1d20',
      'bg-card': '#1d1d22',
      'bg-raised': '#2e2e33',
      'text-1': '#edeef2',
      'text-2': '#a3a6b0',
      'text-3': '#9c9ea7',
      'legacy-success': '#22c55e',
    };
    for (const [name, value] of Object.entries(legacyPalette))
      expect(requiredToken(root, name), '--' + name).toBe(value);

    const computedPalette = Object.fromEntries(
      [
        'background',
        'foreground',
        'card',
        'card-foreground',
        'popover',
        'popover-foreground',
        'success',
      ].map((name) => {
        const utilityValue = token(indexCss, 'color-' + name);
        const semanticName = utilityValue ? /^var\(--([\w-]+)\)$/.exec(utilityValue)?.[1] : null;
        const semanticValue = semanticName ? requiredToken(root, semanticName) : null;
        const legacyName = semanticValue ? /^var\(--([\w-]+)\)$/.exec(semanticValue)?.[1] : null;
        return [name, legacyName ? requiredToken(root, legacyName) : semanticValue];
      }),
    );
    expect(computedPalette).toEqual({
      background: '#1c1d20',
      foreground: '#edeef2',
      card: '#1d1d22',
      'card-foreground': '#edeef2',
      popover: '#1d1d22',
      'popover-foreground': '#edeef2',
      success: '#22c55e',
    });

    expect(css).not.toMatch(/(?:^|\n)\.(?:dark|light)\s*\{/);
    expect(css).not.toContain(':root:not(.dark):not(.light)');
  });
});
