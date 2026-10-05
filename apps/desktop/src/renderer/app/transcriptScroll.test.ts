import { describe, expect, it } from 'vitest';
import { canScroll, isLatestVisible } from './transcriptScroll';

const base = { viewportBottom: 700, scrollTop: 0, scrollHeight: 700, clientHeight: 700 };

describe('isLatestVisible', () => {
  it('treats a short transcript whose tail ends above the viewport bottom as at the latest', () => {
    expect(isLatestVisible({ ...base, tailBottom: 320 })).toBe(true);
  });

  it('is true when the tail is aligned with the viewport bottom', () => {
    expect(isLatestVisible({ ...base, tailBottom: 701 })).toBe(true);
  });

  it('is false when the tail is below the visible area', () => {
    expect(isLatestVisible({ ...base, tailBottom: 900 })).toBe(false);
  });

  it('falls back to scroll distance when the tail is not rendered', () => {
    expect(
      isLatestVisible({ ...base, tailBottom: null, scrollHeight: 2000, scrollTop: 1300 }),
    ).toBe(true);
    expect(isLatestVisible({ ...base, tailBottom: null, scrollHeight: 2000, scrollTop: 400 })).toBe(
      false,
    );
  });
});

describe('canScroll', () => {
  it('is false when content fits the viewport', () => {
    expect(canScroll({ scrollHeight: 700, clientHeight: 700 })).toBe(false);
    expect(canScroll({ scrollHeight: 900, clientHeight: 700 })).toBe(true);
  });
});
