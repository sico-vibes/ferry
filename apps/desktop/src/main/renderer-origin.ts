export function isTrustedRendererOrigin(url: string, devUrl?: string): boolean {
  try {
    const actual = new URL(url);
    if (devUrl) return actual.origin === new URL(devUrl).origin;
    // File URLs have opaque origins and the router may change their pathname.
    // Trust is additionally bound to this window's main frame in isTrustedSender.
    return actual.protocol === 'file:' && actual.host === '';
  } catch {
    return false;
  }
}
