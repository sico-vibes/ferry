import { app, Menu, Notification, Tray, type BrowserWindow } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';

/** Window/tray/notification preferences. They belong to this desktop install, not the engine. */
export interface ShellPreferences {
  /** Close (X) hides Ferry to the tray instead of quitting. */
  closeToTray: boolean;
  notifyChatFinished: boolean;
  notifyApproval: boolean;
  /** The one-time "still running in the tray" notice has been shown. */
  trayNoticeShown: boolean;
}

export const DEFAULT_SHELL_PREFERENCES: ShellPreferences = {
  closeToTray: true,
  notifyChatFinished: true,
  notifyApproval: true,
  trayNoticeShown: false,
};

const preferenceKeys = Object.keys(DEFAULT_SHELL_PREFERENCES) as (keyof ShellPreferences)[];

export function parseShellPreferences(raw: unknown): ShellPreferences {
  const result = { ...DEFAULT_SHELL_PREFERENCES };
  if (!raw || typeof raw !== 'object') return result;
  for (const key of preferenceKeys) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value === 'boolean') result[key] = value;
  }
  return result;
}

/** Accepts only known boolean fields from the renderer. */
export function parseShellPreferencePatch(raw: unknown): Partial<ShellPreferences> {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid preferences');
  const patch: Partial<ShellPreferences> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!preferenceKeys.includes(key as keyof ShellPreferences) || typeof value !== 'boolean')
      throw new Error(`Invalid preference: ${key}`);
    patch[key as keyof ShellPreferences] = value;
  }
  return patch;
}

export type ShellNotificationKind = 'finished' | 'approval' | 'error';
export interface ShellNotification {
  kind: ShellNotificationKind;
  sessionId: string;
  title: string;
  body: string;
  route?: '/models/health';
}

export function parseShellNotification(raw: unknown): ShellNotification {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid notification');
  const value = raw as Record<string, unknown>;
  const text = (input: unknown, max: number) =>
    typeof input === 'string' ? input.slice(0, max) : '';
  if (value.kind !== 'finished' && value.kind !== 'approval' && value.kind !== 'error')
    throw new Error('Invalid notification kind');
  const sessionId = text(value.sessionId, 200);
  if (!sessionId) throw new Error('Notification needs a session');
  return {
    kind: value.kind,
    sessionId,
    title: text(value.title, 200),
    body: text(value.body, 500),
    ...(value.route === '/models/health' ? { route: value.route } : {}),
  };
}

/** Notify only while Ferry is out of sight, and only for the kinds the user left on. */
export function shouldNotify(
  preferences: ShellPreferences,
  kind: ShellNotificationKind,
  windowVisibleAndFocused: boolean,
): boolean {
  if (windowVisibleAndFocused) return false;
  return kind === 'approval' ? preferences.notifyApproval : preferences.notifyChatFinished;
}

export type ShellCommand =
  { type: 'open-session'; sessionId: string } | { type: 'new-chat' } | { type: 'open-models' };

export class DesktopShell {
  private preferences: ShellPreferences;
  private tray: Tray | null = null;
  private quitting = false;

  constructor(
    private readonly options: {
      preferencesPath: string;
      iconPath: string;
      /** Tests and smokes drive window closing directly; keep Ferry's plain quit there. */
      enabled: boolean;
      getWindow: () => BrowserWindow | null;
      openWindow: () => void;
      send: (command: ShellCommand) => void;
    },
  ) {
    this.preferences = this.read();
  }

  getPreferences(): ShellPreferences {
    return { ...this.preferences };
  }

  setPreferences(patch: Partial<ShellPreferences>): ShellPreferences {
    this.preferences = { ...this.preferences, ...patch };
    writeFileSync(this.options.preferencesPath, JSON.stringify(this.preferences), 'utf8');
    return this.getPreferences();
  }

  /** Called from before-quit: from here on, closing the window really closes it. */
  markQuitting(quitting = true): void {
    this.quitting = quitting;
  }

  createTray(): void {
    if (!this.options.enabled || this.tray) return;
    this.tray = new Tray(this.options.iconPath);
    this.tray.setToolTip('Ferry');
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: 'Open Ferry',
          click: () => {
            this.show();
          },
        },
        {
          label: 'New chat',
          click: () => {
            this.show();
            this.options.send({ type: 'new-chat' });
          },
        },
        { type: 'separator' },
        {
          label: 'Quit Ferry',
          click: () => {
            app.quit();
          },
        },
      ]),
    );
    this.tray.on('click', () => {
      this.show();
    });
  }

  attachWindow(window: BrowserWindow): void {
    window.on('close', (event) => {
      if (!this.options.enabled || this.quitting || !this.preferences.closeToTray) return;
      event.preventDefault();
      window.hide();
      if (!this.preferences.trayNoticeShown && Notification.isSupported()) {
        this.setPreferences({ trayNoticeShown: true });
        new Notification({
          title: 'Ferry is still running',
          body: 'Chats keep working in the background. Quit from the tray icon.',
          icon: this.options.iconPath,
        }).show();
      }
    });
  }

  notify(input: ShellNotification): boolean {
    const window = this.options.getWindow();
    const inView = Boolean(window?.isVisible() && !window.isMinimized() && window.isFocused());
    if (!shouldNotify(this.preferences, input.kind, inView) || !Notification.isSupported())
      return false;
    const notification = new Notification({
      title: input.title || 'Ferry',
      body: input.body,
      icon: this.options.iconPath,
    });
    notification.on('click', () => {
      this.show();
      this.options.send(
        input.route
          ? { type: 'open-models' }
          : { type: 'open-session', sessionId: input.sessionId },
      );
    });
    notification.show();
    return true;
  }

  show(): void {
    const window = this.options.getWindow();
    if (!window) {
      this.options.openWindow();
      return;
    }
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  dispose(): void {
    this.tray?.destroy();
    this.tray = null;
  }

  private read(): ShellPreferences {
    try {
      return parseShellPreferences(JSON.parse(readFileSync(this.options.preferencesPath, 'utf8')));
    } catch {
      return { ...DEFAULT_SHELL_PREFERENCES };
    }
  }
}
