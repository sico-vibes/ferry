/**
 * True when a domain is served by the real engine. The desktop app always uses the engine; only the
 * web preview routes domains to mock data.
 */
export function usesRealDomain(domain: string): boolean {
  if (window.ferryHost) return true;
  return window.ferryHybrid?.getRealDomains().includes(domain) ?? false;
}
