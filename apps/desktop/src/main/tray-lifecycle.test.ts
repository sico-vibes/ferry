import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';
import { expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  quit: vi.fn(),
  menu: [] as { label?: string; click?: () => void }[],
  tray: null as EventEmitter | null,
  destroyed: vi.fn(),
}));
vi.mock('electron', () => ({
  app: { quit: state.quit },
  Notification: { isSupported: () => false },
  Menu: {
    buildFromTemplate: (menu: typeof state.menu) => {
      state.menu = menu;
      return menu;
    },
  },
  Tray: class extends EventEmitter {
    constructor() {
      super();
      state.tray = this;
    }
    setToolTip() {
      return undefined;
    }
    setContextMenu() {
      return undefined;
    }
    destroy() {
      state.destroyed();
    }
  },
}));
const { DesktopShell } = await import('./desktop-shell.js');
it('hides to tray, restores a minimized window, quits and restores preferences after restart', () => {
  const root = mkdtempSync(join(tmpdir(), 'ferry-tray-fixture-'));
  const window = Object.assign(new EventEmitter(), {
    hide: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    restore: vi.fn(),
    isMinimized: () => true,
  });
  const options = {
    preferencesPath: join(root, 'preferences.json'),
    iconPath: 'fixture.ico',
    enabled: true,
    getWindow: () => window as unknown as BrowserWindow,
    openWindow: vi.fn(),
    send: vi.fn(),
  };
  try {
    const shell = new DesktopShell(options);
    shell.createTray();
    shell.createTray();
    shell.attachWindow(options.getWindow());
    const event = { preventDefault: vi.fn() };
    window.emit('close', event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(window.hide).toHaveBeenCalledOnce();
    state.tray?.emit('click');
    expect(window.restore).toHaveBeenCalledOnce();
    expect(window.show).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
    state.menu.find((item) => item.label === 'Quit Ferry')?.click?.();
    expect(state.quit).toHaveBeenCalledOnce();
    shell.markQuitting();
    event.preventDefault.mockClear();
    window.emit('close', event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    shell.setPreferences({ closeToTray: false });
    shell.dispose();
    expect(state.destroyed).toHaveBeenCalledOnce();
    expect(new DesktopShell(options).getPreferences().closeToTray).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});
