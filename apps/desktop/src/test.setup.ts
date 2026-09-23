import '@testing-library/jest-dom/vitest';

class TestResizeObserver implements ResizeObserver {
  observe(): void {
    return undefined;
  }
  unobserve(): void {
    return undefined;
  }
  disconnect(): void {
    return undefined;
  }
}

globalThis.ResizeObserver = TestResizeObserver;
if (typeof Element !== 'undefined') {
  Element.prototype.scrollIntoView = () => undefined;
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => undefined;
  Element.prototype.releasePointerCapture = () => undefined;
}
if (typeof window !== 'undefined') window.scrollTo = () => undefined;
