import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KEYBINDINGS,
  matchesKeybinding,
  parseKeybindings,
  type Keybinding,
} from '../src/keybindings';

describe('keybindings', () => {
  it('merges valid overrides over defaults and reports conflicting chords', () => {
    const result = parseKeybindings({
      bindings: [
        { command: 'palette.open', key: 'Ctrl+P' },
        { command: 'chat.new', key: 'Ctrl+P' },
      ],
    });
    expect(result.bindings.find((binding) => binding.command === 'palette.open')?.key).toBe(
      'Ctrl+P',
    );
    expect(result.bindings.find((binding) => binding.command === 'sidebar.toggle')).toEqual(
      DEFAULT_KEYBINDINGS[2],
    );
    expect(result.errors[0]).toContain('Key conflict');
  });
  it('falls back to defaults and reports invalid schemas', () => {
    const result = parseKeybindings({ bindings: [{ command: 'x', key: 'x', when: ['invalid'] }] });
    expect(result.bindings).toEqual(DEFAULT_KEYBINDINGS);
    expect(result.errors).toHaveLength(1);
  });
  it('evaluates when clauses and modifier keys', () => {
    const binding: Keybinding = { command: 'x', key: 'Ctrl+Shift+K', when: ['paletteOpen'] };
    expect(
      matchesKeybinding(
        binding,
        { key: 'k', ctrlKey: true, shiftKey: true },
        { paletteOpen: true },
      ),
    ).toBe(true);
    expect(
      matchesKeybinding(
        binding,
        { key: 'k', ctrlKey: true, shiftKey: true },
        { paletteOpen: false },
      ),
    ).toBe(false);
  });
});
