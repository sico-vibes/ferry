export function getTitlebarOverlayRightReserve(
  visible: boolean,
  area: Pick<DOMRectReadOnly, 'x' | 'width'>,
  innerWidth: number,
): number {
  if (!visible || area.width <= 0) return 0;
  return Math.min(240, Math.max(0, innerWidth - (area.x + area.width)));
}
