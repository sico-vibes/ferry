/** Pixels of slack before the transcript counts as scrolled away from the latest message. */
export const TAIL_SLACK_PX = 2;

export interface TailGeometry {
  /** Bottom edge of the last transcript message, or null when it is not rendered. */
  tailBottom: number | null;
  viewportBottom: number;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/**
 * True when the latest message is fully visible. A short transcript whose last message ends
 * above the viewport bottom counts as "at the latest", so "Jump to latest" never shows for it.
 */
export function isLatestVisible(geometry: TailGeometry): boolean {
  if (geometry.tailBottom !== null)
    return geometry.tailBottom - geometry.viewportBottom <= TAIL_SLACK_PX;
  return geometry.scrollHeight - geometry.scrollTop - geometry.clientHeight <= TAIL_SLACK_PX;
}

/** True when the viewport has content to scroll; wheel or key input does nothing otherwise. */
export function canScroll(geometry: Pick<TailGeometry, 'scrollHeight' | 'clientHeight'>): boolean {
  return geometry.scrollHeight - geometry.clientHeight > TAIL_SLACK_PX;
}

export function readTailGeometry(element: HTMLElement, tail: HTMLElement | null): TailGeometry {
  return {
    tailBottom: tail ? tail.getBoundingClientRect().bottom : null,
    viewportBottom: element.getBoundingClientRect().bottom,
    scrollTop: element.scrollTop,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
  };
}
