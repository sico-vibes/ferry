import { describe, expect, it } from 'vitest';
import { scorePaletteMatch } from './paletteSearch';
describe('palette search ranking', () => {
  it('ranks direct matches above fuzzy matches and supports the commands prefix', () => {
    expect(scorePaletteMatch('Open Settings', 'settings')).toBeGreaterThan(
      scorePaletteMatch('Session settingshelper', 'settings'),
    );
    const commandScore = scorePaletteMatch('New Chat', '> New Chat');
    expect(commandScore).toBeGreaterThan(0);
    expect(commandScore).toBeLessThanOrEqual(1);
    expect(scorePaletteMatch('Toggle density', '> density')).toBeGreaterThan(0);
    expect(scorePaletteMatch('New chat', '> density')).toBe(0);
  });
});
