import { describe, expect, it } from 'vitest';
import { getTitlebarOverlayRightReserve } from './titlebarOverlay';

describe('titlebar overlay right reserve', () => {
  it('reserves no space when the overlay is hidden or has no width', () => {
    expect(getTitlebarOverlayRightReserve(false, { x: 0, width: 1300 }, 1440)).toBe(0);
    expect(getTitlebarOverlayRightReserve(true, { x: 0, width: 0 }, 1440)).toBe(0);
  });

  it('reserves the space to the right of a visible overlay', () => {
    expect(getTitlebarOverlayRightReserve(true, { x: 0, width: 1300 }, 1440)).toBe(140);
  });

  it('clamps the reserve between 0 and 240 pixels', () => {
    expect(getTitlebarOverlayRightReserve(true, { x: 0, width: 1000 }, 1440)).toBe(240);
    expect(getTitlebarOverlayRightReserve(true, { x: 0, width: 1500 }, 1440)).toBe(0);
  });
});
