export function isTrustedRendererOrigin(
  url: string,
  devUrl?: string,
  rendererFileUrl?: string,
): boolean {
  try {
    const actual = new URL(url);
    if (devUrl) {
      const expected = new URL(devUrl);
      return actual.origin === expected.origin && actual.pathname === expected.pathname;
    }
    if (!rendererFileUrl) return false;
    const expected = new URL(rendererFileUrl);
    return (
      actual.protocol === 'file:' && actual.host === '' && actual.pathname === expected.pathname
    );
  } catch {
    return false;
  }
}
