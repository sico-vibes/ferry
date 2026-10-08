// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

it('restores the resolved theme before any settings request or React mount', async () => {
  localStorage.setItem('ferry.resolvedTheme', 'dark');
  document.documentElement.className = 'light';
  document.documentElement.dataset.theme = 'light';
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
  const { bootstrapTheme } = await import('./theme-bootstrap');
  bootstrapTheme();
  expect(document.documentElement.dataset.theme).toBe('dark');
  expect(document.documentElement.classList.contains('dark')).toBe(true);
  expect(document.documentElement.classList.contains('light')).toBe(false);
  expect(localStorage.getItem('ferry-theme')).toBe('dark');
  expect(matchMedia).not.toHaveBeenCalled();
  const { initializeTheme } = await import('@ferry/ui');
  initializeTheme();
  expect(document.documentElement.dataset.theme).toBe('dark');
});
