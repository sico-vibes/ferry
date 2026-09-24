import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const tokens = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');
const color = (name: string) => {
  const value = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(tokens)?.[1];
  if (!value) throw new Error(`Missing color token --${name}`);
  return value;
};
const luminance = (hex: string) => {
  const [red = 0, green = 0, blue = 0] =
    hex
      .slice(1)
      .match(/.{2}/g)
      ?.map((channel) => parseInt(channel, 16) / 255) ?? [];
  const linear = (channel: number) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
};
const contrast = (foreground: string, background: string) => {
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return ((values[0] ?? 0) + 0.05) / ((values[1] ?? 0) + 0.05);
};

describe('accessible text token contrast', () => {
  it.each(['bg-canvas', 'bg-card', 'bg-panel'])('passes AA on --%s', (surface) => {
    expect(contrast(color('text-3'), color(surface))).toBeGreaterThanOrEqual(4.5);
  });
});
