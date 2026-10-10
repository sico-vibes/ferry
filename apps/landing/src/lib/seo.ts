function toUrl(value: string): URL | null {
  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    return new URL(withProtocol);
  } catch {
    return null;
  }
}

/** Absolute site origin for metadata. Set NEXT_PUBLIC_SITE_URL on Vercel. */
export function getSiteUrl(): URL {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (configured) {
    const url = toUrl(configured);
    if (url) return url;
  }
  const production = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (production) {
    const url = toUrl(production);
    if (url) return url;
  }
  const preview = process.env.VERCEL_URL?.trim();
  if (preview) {
    const url = toUrl(preview);
    if (url) return url;
  }
  return new URL('http://localhost:3000');
}
