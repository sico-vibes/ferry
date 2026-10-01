import { useEffect, useSyncExternalStore } from 'react';

export type ThemeMode = 'system' | 'dark' | 'light';
const storageKey = 'ferry-theme';
const mediaQuery = '(prefers-color-scheme: dark)';
let mode: ThemeMode = 'system';
const listeners = new Set<() => void>();

function getMedia() {
  return typeof window === 'undefined' || typeof window.matchMedia !== 'function'
    ? null
    : window.matchMedia(mediaQuery);
}

function getResolvedTheme(): 'dark' | 'light' {
  if (mode !== 'system') return mode;
  return getMedia()?.matches ? 'dark' : 'light';
}

function applyTheme() {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.classList.remove('dark', 'light');
  root.classList.add(getResolvedTheme());
  root.dataset.theme = getResolvedTheme();
}

function notify() {
  applyTheme();
  listeners.forEach((listener) => {
    listener();
  });
}

function readStoredMode(): ThemeMode {
  try {
    const stored = window.localStorage.getItem(storageKey);
    return stored === 'dark' || stored === 'light' || stored === 'system' ? stored : 'system';
  } catch {
    return 'system';
  }
}

export function setTheme(next: ThemeMode) {
  mode = next;
  try {
    window.localStorage.setItem(storageKey, next);
  } catch {
    // Theme still applies for this session when storage is unavailable.
  }
  notify();
}

export function getTheme(): ThemeMode {
  return mode;
}

export function getResolvedThemeSnapshot(): 'dark' | 'light' {
  return getResolvedTheme();
}

let systemListenerRegistered = false;
export function initializeTheme() {
  if (typeof window === 'undefined') return;
  mode = readStoredMode();
  applyTheme();
  const media = getMedia();
  if (!systemListenerRegistered && media) {
    media.addEventListener('change', () => {
      if (mode === 'system') applyTheme();
      listeners.forEach((listener) => {
        listener();
      });
    });
    systemListenerRegistered = true;
  }
  listeners.forEach((listener) => {
    listener();
  });
}

export function subscribeTheme(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function subscribeSystem(listener: () => void) {
  listeners.add(listener);
  const media = getMedia();
  media?.addEventListener('change', listener);
  return () => {
    listeners.delete(listener);
    media?.removeEventListener('change', listener);
  };
}

export function useTheme() {
  const theme = useSyncExternalStore(subscribeTheme, getTheme, () => 'system');
  const resolvedTheme = useSyncExternalStore<'dark' | 'light'>(
    subscribeSystem,
    getResolvedTheme,
    () => 'light',
  );
  useEffect(() => {
    initializeTheme();
  }, []);
  return { theme, resolvedTheme, setTheme };
}

if (typeof window !== 'undefined') initializeTheme();
