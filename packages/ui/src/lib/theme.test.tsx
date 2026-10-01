// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { useTheme } from './theme';

function ThemeProbe() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  return (
    <div>
      <span>
        {theme}:{resolvedTheme}
      </span>
      <button
        onClick={() => {
          setTheme('dark');
        }}
      >
        Dark
      </button>
      <button
        onClick={() => {
          setTheme('light');
        }}
      >
        Light
      </button>
      <button
        onClick={() => {
          setTheme('system');
        }}
      >
        System
      </button>
    </div>
  );
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.className = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('theme selection', () => {
  it('follows a changing system preference', () => {
    const listeners: (() => void)[] = [];
    const media = {
      matches: false,
      addEventListener: vi.fn((_event: string, listener: () => void) => {
        listeners.push(listener);
      }),
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => media as unknown as MediaQueryList),
    );
    localStorage.setItem('ferry-theme', 'system');
    render(<ThemeProbe />);
    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(screen.getByText('system:light')).toBeTruthy();
    act(() => {
      media.matches = true;
      listeners.forEach((listener) => {
        listener();
      });
    });
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(screen.getByText('system:dark')).toBeTruthy();
  });

  it('persists explicit dark and light choices', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    );
    render(<ThemeProbe />);
    screen.getByRole('button', { name: 'Dark' }).click();
    expect(localStorage.getItem('ferry-theme')).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    screen.getByRole('button', { name: 'Light' }).click();
    expect(localStorage.getItem('ferry-theme')).toBe('light');
    expect(document.documentElement.classList.contains('light')).toBe(true);
    screen.getByRole('button', { name: 'System' }).click();
    expect(localStorage.getItem('ferry-theme')).toBe('system');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(screen.getByText('system:dark')).toBeTruthy();
  });
});
