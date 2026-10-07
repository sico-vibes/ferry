import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: {}, Menu: {}, Notification: {}, Tray: vi.fn() }));

const {
  DEFAULT_SHELL_PREFERENCES,
  parseShellNotification,
  parseShellPreferencePatch,
  parseShellPreferences,
  shouldNotify,
} = await import('./desktop-shell.js');

describe('desktop shell preferences', () => {
  it('defaults to close-to-tray with notifications on', () => {
    expect(parseShellPreferences(undefined)).toEqual(DEFAULT_SHELL_PREFERENCES);
    expect(DEFAULT_SHELL_PREFERENCES.closeToTray).toBe(true);
  });

  it('keeps known booleans and ignores everything else from disk', () => {
    expect(parseShellPreferences({ closeToTray: false, extra: 1, notifyApproval: 'no' })).toEqual({
      ...DEFAULT_SHELL_PREFERENCES,
      closeToTray: false,
    });
  });

  it('rejects unknown or non-boolean fields from the renderer', () => {
    expect(parseShellPreferencePatch({ notifyChatFinished: false })).toEqual({
      notifyChatFinished: false,
    });
    expect(() => parseShellPreferencePatch({ closeToTray: 'yes' })).toThrow();
    expect(() => parseShellPreferencePatch({ shell: true })).toThrow();
  });
});

describe('desktop notifications', () => {
  it('stays quiet while the window is in view', () => {
    expect(shouldNotify(DEFAULT_SHELL_PREFERENCES, 'finished', true)).toBe(false);
    expect(shouldNotify(DEFAULT_SHELL_PREFERENCES, 'finished', false)).toBe(true);
  });

  it('follows the per-kind switches', () => {
    const quiet = { ...DEFAULT_SHELL_PREFERENCES, notifyChatFinished: false };
    expect(shouldNotify(quiet, 'finished', false)).toBe(false);
    expect(shouldNotify(quiet, 'error', false)).toBe(false);
    expect(shouldNotify(quiet, 'approval', false)).toBe(true);
  });

  it('validates and trims notification input', () => {
    const parsed = parseShellNotification({
      kind: 'finished',
      sessionId: 'session_1',
      title: 'x'.repeat(400),
      body: 'Reply ready.',
    });
    expect(parsed.title).toHaveLength(200);
    expect(() => parseShellNotification({ kind: 'other', sessionId: 's' })).toThrow();
    expect(() => parseShellNotification({ kind: 'finished', sessionId: '' })).toThrow();
  });
});
