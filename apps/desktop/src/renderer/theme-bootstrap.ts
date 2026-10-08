export const THEME_STORAGE_KEY = 'ferry.resolvedTheme';
export function applyResolvedTheme(theme: 'dark' | 'light') {
  document.documentElement.dataset.theme = theme;
  document.documentElement.classList.toggle('dark', theme === 'dark');
  document.documentElement.classList.toggle('light', theme === 'light');
}
export function bootstrapTheme() {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    /* Storage can be unavailable. */
  }
  const preview = new URLSearchParams(location.search).get('theme');
  const theme =
    preview === 'dark' || preview === 'light'
      ? preview
      : stored === 'dark' || stored === 'light'
        ? stored
        : matchMedia('(prefers-color-scheme: light)').matches
          ? 'light'
          : 'dark';
  applyResolvedTheme(theme);
  // The UI kit initializes independently before React mounts. Seed its theme too,
  // then let the resolved settings restore the user's System/Light/Dark preference.
  try {
    localStorage.setItem('ferry-theme', theme);
  } catch {
    /* Theme still applies when storage is unavailable. */
  }
}
bootstrapTheme();
