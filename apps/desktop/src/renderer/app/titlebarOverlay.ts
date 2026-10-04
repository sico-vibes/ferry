export function getTitlebarOverlayRightReserve(
  visible: boolean,
  area: Pick<DOMRectReadOnly, 'x' | 'width'>,
  innerWidth: number,
  hiddenOverlayFallback = 0,
): number {
  if (!visible || area.width <= 0) return hiddenOverlayFallback;
  return Math.min(240, Math.max(0, innerWidth - (area.x + area.width)));
}
